import { app, Notification } from 'electron'
import { randomUUID } from 'crypto'
import type { ActivityLogPayload, AlertType, HrmsClock, LoginResponse, MeResponse, TrackerProject } from '@shared/api-contract'
import type { ActionResult, ActivityView, TrackerDisplayStatus, TrackerState } from '@shared/ipc'
import { KvKey, kvGet, kvSet } from '../data/kv-store'
import { allOfKind, enqueue, getItem, pendingStats } from '../data/outbox'
import { ApiClient, AuthError, HttpError, NetworkError, validateServerUrl } from '../platform/api-client'
import { applyServerSchedule, getConfig, saveConfig } from '../platform/config'
import { createLogger } from '../platform/logger'
import { clearAuth, loadAuth, saveAuth, StoredAuth } from '../platform/secure-storage'
import { inputMonitor } from './input-monitor'
import { cleanupOrphanFiles, readPendingImage, ScreenshotService, StorageLevel } from './screenshot-service'
import { SessionTracker } from './session-tracker'
import { SyncEngine } from './sync-engine'
import type { DeepLink } from '../app/deep-link'

/**
 * Application service: the one object the UI layer (IPC, tray, window) talks to.
 *
 * Owns the signed-in identity and wires together:
 *   SessionTracker    (what is being tracked)
 *   ScreenshotService (when to capture)
 *   SyncEngine        (getting it to the server)
 *
 * State flows one way: services call `emit()`, listeners (IPC/tray) receive a fresh
 * `TrackerState` snapshot. Nothing outside this class mutates tracking state.
 */

const log = createLogger('service')

/** Minimum time between two storage alerts of the same type. */
const STORAGE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000

export class TrackerService {
  private auth: StoredAuth | null = null
  /** The stored token was rejected. Tracking continues locally until the employee signs in again. */
  private authExpired = false
  private client: ApiClient | null = null

  private trackingAllowed = true
  private trackingBlockedReason: string | null = null
  /** The HRMS clock as last reported. The timer follows it (see followHrmsClock). */
  private hrmsClock: HrmsClock | null = null
  /** The running session was paused because the HRMS went on a break, not by the employee. */
  private pausedByHrms = false
  private inputPermissionOk = true
  private screenPermissionOk = true
  private screenLocked = false
  private notice: string | null = null
  /** Projects offered at Start; refreshed with every permission check. */
  private projects: TrackerProject[] = []

  private permissionTimer: NodeJS.Timeout | null = null
  private listeners: Array<(s: TrackerState) => void> = []

  readonly session: SessionTracker
  readonly screenshots: ScreenshotService
  readonly sync: SyncEngine

  constructor() {
    this.session = new SessionTracker({
      onChange: () => this.emit(),
      onQueued: () => this.sync.trigger(),
      onRunningChanged: (running) => (running ? this.screenshots.start() : this.screenshots.stop()),
      notify: (message) => this.showNotice(message, true),
      inputAvailable: () => this.inputPermissionOk
    })

    this.screenshots = new ScreenshotService({
      context: () => {
        const s = this.session.current
        return s?.status === 'ACTIVE' ? { employeeId: s.employeeId, sessionId: s.id } : null
      },
      isScreenLocked: () => this.screenLocked,
      onCaptured: () => {
        this.sync.trigger()
        this.emit()
      },
      onPermission: (ok) => this.setScreenPermission(ok),
      onStorageLevel: (level) => this.handleStorageLevel(level)
    })

    this.sync = new SyncEngine({
      client: () => (this.authExpired ? null : this.client),
      employeeId: () => this.auth?.user.id ?? null,
      onAuthExpired: () => this.handleAuthExpired(),
      onChange: () => this.emit()
    })
  }

  /** Startup sequence. Order matters: input hook before crash recovery (recovery flushes a bucket). */
  init(): void {
    this.inputPermissionOk = inputMonitor.start()
    cleanupOrphanFiles()

    if (this.session.recoverAfterRestart()) {
      this.notice = 'Your previous session ended unexpectedly. It was saved as interrupted and will be uploaded.'
    }

    const auth = loadAuth()
    if (auth) {
      this.activateAuth(auth)
      if (!this.inputPermissionOk) {
        this.queueAlert('PERMISSION_UNAVAILABLE', 'Keyboard/mouse activity counting is unavailable on the employee computer.')
      }
    }
  }

  // ================================================================== state

  onState(listener: (s: TrackerState) => void): void {
    this.listeners.push(listener)
  }

  private emit(): void {
    const snapshot = this.getState()
    for (const l of this.listeners) {
      try {
        l(snapshot)
      } catch (e) {
        log.error('State listener failed', e)
      }
    }
  }

  getState(): TrackerState {
    const live = this.session.current
    const stats = pendingStats(this.auth?.user.id ?? null)
    const signedIn = !!this.auth && !this.authExpired

    let status: TrackerDisplayStatus
    if (!signedIn) status = 'signed-out'
    else if (!this.trackingAllowed || !this.inputPermissionOk || !this.screenPermissionOk) status = 'permission-issue'
    else if (live?.status === 'ACTIVE') status = 'active'
    else if (live?.status === 'PAUSED') status = 'paused'
    else status = 'idle'

    return {
      status,
      user: this.auth?.user ?? null,
      apiBaseUrl: this.auth?.apiBaseUrl ?? getConfig().apiBaseUrl,
      sessionId: live?.id ?? null,
      sessionStatus: live?.status ?? null,
      sessionProjectId: live?.projectId ?? null,
      projects: this.projects,
      startedAt: live ? new Date(live.startedAt).toISOString() : null,
      elapsedMs: this.session.elapsedMs(),
      stateAt: Date.now(),
      online: this.sync.online,
      syncing: this.sync.syncing,
      pendingCount: stats.count,
      pendingBytes: stats.bytes,
      storageLimitBytes: getConfig().storageLimitMb * 1024 * 1024,
      lastSyncAt: this.sync.lastSyncAt,
      lastError: this.sync.lastError,
      trackingAllowed: this.trackingAllowed,
      trackingBlockedReason: this.trackingBlockedReason,
      hrmsClock: this.hrmsClock,
      inputPermissionOk: this.inputPermissionOk,
      screenPermissionOk: this.screenPermissionOk,
      notice: this.notice,
      launchAtStartup: app.getLoginItemSettings().openAtLogin
    }
  }

  // ================================================================== authentication

  private activateAuth(auth: StoredAuth): void {
    this.auth = auth
    this.authExpired = false
    this.client = new ApiClient(auth.apiBaseUrl, auth.token)
    this.sync.start()
    this.startPermissionChecks()
    // Ask straight away: the HRMS clock may have moved while the app was closed.
    void this.checkPermission()
    this.emit()
  }

  async login(apiBaseUrl: string, email: string, password: string): Promise<ActionResult> {
    const url = apiBaseUrl.trim().replace(/\/+$/, '')
    const urlError = validateServerUrl(url)
    if (urlError) return { ok: false, error: urlError }

    try {
      this.completeSignIn(url, await new ApiClient(url).login(email.trim(), password))
      return { ok: true }
    } catch (e) {
      if (e instanceof AuthError) return { ok: false, error: 'Invalid email or password.' }
      if (e instanceof NetworkError) return { ok: false, error: `Cannot reach the HRMS server at ${url}.` }
      if (e instanceof HttpError) return { ok: false, error: e.message }
      log.error('Login failed unexpectedly', e)
      return { ok: false, error: 'Sign-in failed. Please try again.' }
    }
  }

  /** Stores a token the server just issued (password or link sign-in) and goes live with it. */
  private completeSignIn(url: string, res: LoginResponse): void {
    const live = this.session.current
    if (live && live.employeeId !== res.user.id) {
      // A different person is signing in on this computer: close the previous person's session.
      log.info('Different employee signed in; interrupting previous session')
      this.session.stop('INTERRUPTED')
    }
    const auth: StoredAuth = { token: res.token, expiresAt: res.expiresAt, apiBaseUrl: url, user: res.user }
    saveAuth(auth)
    saveConfig({ apiBaseUrl: url })
    this.trackingAllowed = res.trackingAllowed
    this.trackingBlockedReason = res.trackingAllowed ? null : (res.reason ?? 'Tracking is not permitted right now.')
    this.notice = null
    applyServerSchedule(res.screenshotsPerHour)
    this.activateAuth(auth)
    log.info(`Signed in as employee ${res.user.id}`)
  }

  /**
   * A krishnatracker://start link from the HRMS — pressed Check in, or Open desktop app.
   *
   * Already signed in here as the person who pressed it → nothing to do; the window is
   * already up, ready to start. Otherwise the link's single-use code signs the app in as
   * them first, so they never retype a password. The timer itself is started here, by
   * the employee, so they can pick the project first. A link naming a server this app
   * has not been using must be confirmed: an unexpected link must not be able to
   * redirect their tracking data.
   */
  async openFromLink(link: DeepLink, confirmServer: (url: string) => Promise<boolean>): Promise<ActionResult> {
    const signedIn = !!this.auth && !this.authExpired
    const known = this.auth?.apiBaseUrl ?? getConfig().apiBaseUrl
    const server = (link.server ?? known).trim().replace(/\/+$/, '')

    const sameAccount = signedIn && server === this.auth?.apiBaseUrl && (!link.user || link.user === this.auth?.user.id)
    if (sameAccount) {
      void this.checkPermission()
      return { ok: true }
    }

    const result = await this.signInFromLink(link, server, known, confirmServer)
    if (!result.ok) this.showNotice(result.error ?? 'Could not sign in from the HRMS link.', false)
    return result
  }

  private async signInFromLink(
    link: DeepLink,
    server: string,
    known: string,
    confirmServer: (url: string) => Promise<boolean>
  ): Promise<ActionResult> {
    if (!link.code) return { ok: false, error: 'Sign in to start the timer.' }
    const urlError = validateServerUrl(server)
    if (urlError) return { ok: false, error: urlError }
    if (server !== known && !(await confirmServer(server))) {
      return { ok: false, error: 'Sign-in from the HRMS link was cancelled.' }
    }

    try {
      this.completeSignIn(server, await new ApiClient(server).redeemLink(link.code))
      return { ok: true }
    } catch (e) {
      if (e instanceof AuthError) return { ok: false, error: 'That link has expired. Press Start timer in the HRMS again.' }
      if (e instanceof NetworkError) return { ok: false, error: `Cannot reach the HRMS server at ${server}.` }
      if (e instanceof HttpError) return { ok: false, error: e.message }
      log.error('Link sign-in failed unexpectedly', e)
      return { ok: false, error: 'Sign-in failed. Please try again.' }
    }
  }

  async logout(): Promise<void> {
    this.session.stop('COMPLETED')
    // Best effort: push what we can while we still have a token. Anything left stays queued
    // for this employee and uploads at their next sign-in.
    await this.sync.drain(5_000)
    try {
      await this.client?.logout()
    } catch {
      /* offline or already revoked */
    }
    clearAuth()
    this.sync.stop()
    this.stopPermissionChecks()
    this.auth = null
    this.client = null
    this.authExpired = false
    this.projects = []
    this.hrmsClock = null
    this.emit()
  }

  private handleAuthExpired(): void {
    if (this.authExpired) return
    log.warn('Auth token rejected by server')
    this.authExpired = true
    this.stopPermissionChecks()
    clearAuth()
    this.showNotice(
      this.session.current
        ? 'Your sign-in expired. Tracking continues and data is saved on this computer. Sign in again to upload it.'
        : 'Your sign-in expired. Please sign in again.',
      true
    )
  }

  // ================================================================== server-side permission

  private startPermissionChecks(): void {
    this.stopPermissionChecks()
    this.permissionTimer = setInterval(() => void this.checkPermission(), getConfig().permissionCheckMinutes * 60_000)
  }

  private stopPermissionChecks(): void {
    if (this.permissionTimer) clearInterval(this.permissionTimer)
    this.permissionTimer = null
  }

  /**
   * Asks the backend whether this employee may be tracked now (e.g. checked in). Also the
   * "tracker connected" heartbeat the HRMS dashboard uses. Offline keeps the last answer.
   */
  async checkPermission(): Promise<void> {
    const client = this.client
    if (!client || this.authExpired) return
    try {
      const me = await client.me()
      // A new cadence from the HRMS applies from the next capture on.
      if (applyServerSchedule(me.screenshotsPerHour) && this.session.current?.status === 'ACTIVE') this.screenshots.start()
      await this.refreshProjects(client)
      this.trackingAllowed = me.trackingAllowed
      this.trackingBlockedReason = me.trackingAllowed ? null : (me.reason ?? 'Tracking is not permitted right now.')
      if (pendingStats(this.auth?.user.id ?? null).count === 0) this.sync.markContact()
      else this.sync.setOnline(true)
      this.followHrmsClock(me)
    } catch (e) {
      if (e instanceof NetworkError) this.sync.setOnline(false)
      else if (e instanceof AuthError) this.handleAuthExpired()
      else log.warn('Permission check failed', e)
    }
    this.emit()
  }

  /** Keeps the last list on failure: an older list beats an empty picker. */
  private async refreshProjects(client: ApiClient): Promise<void> {
    try {
      this.projects = (await client.getProjects()).projects
    } catch (e) {
      if (e instanceof AuthError) throw e
      log.warn('Could not load projects', e)
    }
  }

  // ================================================================== session controls

  async start(projectId: string | null = null): Promise<ActionResult> {
    if (!this.auth || this.authExpired) return { ok: false, error: 'Please sign in first.' }
    if (this.session.current) return { ok: true }
    // Re-check with the server if reachable. Offline starts are allowed and synced later.
    await this.checkPermission()
    if (!this.trackingAllowed) {
      return { ok: false, error: this.trackingBlockedReason ?? 'Tracking is not permitted right now.' }
    }
    // Only a project the HRMS offered; anything else starts the timer without one.
    const project = this.projects.find((p) => p.id === projectId) ?? null
    this.session.start(this.auth.user.id, project?.id ?? null)
    this.notify(
      'Tracking started',
      project ? `Tracking your time on ${project.name}.` : 'Your work time and activity are now being tracked.'
    )
    return { ok: true }
  }

  pause(): void {
    this.session.pause()
    this.pausedByHrms = false
  }

  resume(): void {
    // On a break in the HRMS the timer stays paused; Resume there brings it back.
    if (this.hrmsClock === 'break') {
      this.showNotice('You are on a break in the HRMS. Resume there and the timer carries on.', false)
      return
    }
    this.session.resume()
    this.pausedByHrms = false
  }

  /**
   * Keeps the timer in step with the HRMS clock, checked every minute:
   *   break     → a running timer pauses (and resumes when the break ends)
   *   working   → a timer the HRMS paused resumes; one the employee paused stays paused
   *   off       → the timer stops: checked out, never checked in, or on leave
   * An older server without `clock` is read from `trackingAllowed`, as before.
   */
  private followHrmsClock(me: MeResponse): void {
    const clock: HrmsClock = me.clock ?? (me.trackingAllowed ? 'working' : 'off')
    this.hrmsClock = clock
    const live = this.session.current
    if (!live) {
      this.pausedByHrms = false
      return
    }

    if (clock === 'break') {
      if (live.status === 'ACTIVE') {
        this.session.pause()
        this.pausedByHrms = true
        this.showNotice('You are on a break in the HRMS, so the timer is paused. It resumes when you do.', true)
      }
    } else if (clock === 'working') {
      if (live.status === 'PAUSED' && this.pausedByHrms) {
        this.session.resume()
        this.pausedByHrms = false
        this.showNotice('Welcome back. The timer is running again.', false)
      }
    } else {
      this.session.stop('COMPLETED')
      this.pausedByHrms = false
      this.sync.trigger(500)
      this.showNotice(`Timer stopped: ${this.trackingBlockedReason ?? 'you are off the clock in the HRMS.'}`, true)
    }
  }

  stop(): void {
    this.session.stop('COMPLETED')
    this.sync.trigger(500)
  }

  // ================================================================== OS events

  setScreenLocked(locked: boolean): void {
    this.screenLocked = locked
  }

  onSuspend(): void {
    this.session.onSuspend()
  }

  onResume(): void {
    this.session.onResume()
    void this.sync.syncNow()
  }

  // ================================================================== "My activity" view

  async getActivity(date: string): Promise<ActivityView> {
    const emp = this.auth?.user.id
    if (!emp) return { date, logs: [], screenshots: [], fromServer: false, error: 'Not signed in' }

    // Local (not yet uploaded) items for that calendar day.
    const onDay = (isoTime: string): boolean => localDate(new Date(isoTime)) === date
    const pendingLogs = allOfKind(emp, 'activity')
      .map((r) => JSON.parse(r.payload) as ActivityLogPayload)
      .filter((l) => onDay(l.intervalStart))
    const pendingShots = allOfKind(emp, 'screenshot')
      .map((r) => JSON.parse(r.payload) as { id: string; capturedAt: string })
      .filter((s) => onDay(s.capturedAt))
      .map((s) => ({ id: s.id, capturedAt: s.capturedAt, pending: true }))

    let serverLogs: ActivityLogPayload[] = []
    let serverShots: ActivityView['screenshots'] = []
    let fromServer = false
    let error: string | null = null
    if (this.client && !this.authExpired) {
      try {
        const [a, s] = await Promise.all([this.client.getActivity(date), this.client.getScreenshots(date)])
        serverLogs = a.logs
        serverShots = s.screenshots.map((x) => ({ id: x.id, capturedAt: x.capturedAt, pending: false }))
        fromServer = true
      } catch (e) {
        error = e instanceof NetworkError ? 'Offline — showing only data saved on this computer.' : (e as Error).message
      }
    }

    // An item can briefly exist in both places (uploaded, list fetched before local delete).
    const seenLogs = new Set(serverLogs.map((l) => l.id))
    const logs = [...serverLogs, ...pendingLogs.filter((l) => !seenLogs.has(l.id))].sort((a, b) =>
      a.intervalStart.localeCompare(b.intervalStart)
    )
    const seenShots = new Set(serverShots.map((s) => s.id))
    const screenshots = [...serverShots, ...pendingShots.filter((s) => !seenShots.has(s.id))].sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt)
    )
    return { date, logs, screenshots, fromServer, error }
  }

  async getScreenshotImage(id: string, pending: boolean): Promise<string | null> {
    if (pending) {
      const row = getItem(id)
      // Only the signed-in employee's own pending rows may be read.
      if (row?.kind === 'screenshot' && row.employee_id === this.auth?.user.id && row.file_path) {
        try {
          return `data:image/jpeg;base64,${readPendingImage(row.file_path).toString('base64')}`
        } catch {
          return null
        }
      }
      // Not found locally: it was uploaded since the list was loaded; fall through to the server.
    }
    if (!this.client || this.authExpired) return null
    try {
      return await this.client.getScreenshotDataUrl(id)
    } catch {
      return null
    }
  }

  // ================================================================== misc

  setLaunchAtStartup(enabled: boolean): void {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    this.emit()
  }

  dismissNotice(): void {
    this.notice = null
    this.emit()
  }

  notify(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  }

  private showNotice(message: string, osNotification: boolean): void {
    this.notice = message
    if (osNotification) this.notify('HRMS Tracker', message)
    this.emit()
  }

  private setScreenPermission(ok: boolean): void {
    if (this.screenPermissionOk && !ok) {
      this.queueAlert('PERMISSION_UNAVAILABLE', 'Screen capture permission is unavailable on the employee computer.')
      this.showNotice('Screenshots could not be captured. Check screen-recording permission.', true)
    }
    if (this.screenPermissionOk !== ok) {
      this.screenPermissionOk = ok
      this.emit()
    }
  }

  private handleStorageLevel(level: StorageLevel): void {
    if (level === 'ok') return
    const type: AlertType = level === 'full' ? 'STORAGE_FULL' : 'STORAGE_NEARLY_FULL'
    const key = KvKey.AlertCooldown(type)
    if (Date.now() - (kvGet<number>(key) ?? 0) < STORAGE_ALERT_COOLDOWN_MS) return
    kvSet(key, Date.now())
    const mb = Math.round(pendingStats(null).bytes / 1024 / 1024)
    const message =
      level === 'full'
        ? `Local tracker storage is full (${mb} MB waiting to upload). Screenshots are paused until data is uploaded.`
        : `Local tracker storage is nearly full (${mb} MB waiting to upload). Connect to the internet so data can upload.`
    this.queueAlert(type, message)
    this.showNotice(message, true)
  }

  /** Alerts go through the outbox, so they reach the admin once the computer is back online. */
  private queueAlert(type: AlertType, message: string): void {
    const employeeId = this.auth?.user.id ?? this.session.current?.employeeId
    if (!employeeId) return
    const id = randomUUID()
    enqueue({
      id,
      employeeId,
      kind: 'alert',
      sessionId: this.session.current?.id ?? null,
      payload: { id, type, message, createdAt: new Date().toISOString() }
    })
    this.sync.trigger()
  }

  /**
   * Orderly shutdown (Quit, OS shutdown, logoff). Ends the session, optionally attempts a
   * bounded final upload, and stops all timers. Safe to call more than once.
   */
  async shutdown(sessionStatus: 'COMPLETED' | 'INTERRUPTED', flush: boolean): Promise<void> {
    this.session.stop(sessionStatus)
    this.screenshots.stop()
    this.stopPermissionChecks()
    if (flush && this.client && !this.authExpired) await this.sync.drain(4_000)
    this.sync.stop()
    this.session.dispose()
    inputMonitor.stop()
  }
}

/** YYYY-MM-DD in the computer's local timezone. */
export function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
