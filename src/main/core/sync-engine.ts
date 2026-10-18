import type { ActivityLogPayload, AlertPayload, SessionPayload } from '@shared/api-contract'
import { KvKey, kvGet, kvSet } from '../data/kv-store'
import { dueItems, markFailed, OutboxRow, remove, resetBackoff, restoreAttempts } from '../data/outbox'
import { ApiClient, AuthError, HttpError, NetworkError } from '../platform/api-client'
import { getConfig } from '../platform/config'
import { createLogger } from '../platform/logger'
import { deletePendingFile, previewOf, readPendingImage } from './screenshot-service'

/**
 * Uploads the outbox to the HRMS backend.
 *
 * Order per cycle: sessions → activity → screenshots → alerts. Sessions go first because
 * activity and screenshots reference them (foreign keys on the server).
 *
 * Failure handling:
 *   NetworkError         → stop the cycle, mark the app offline; periodic cycles retry.
 *   AuthError (401)      → stop the cycle, ask the employee to sign in again.
 *   HttpError retryable  → that row backs off (5 s … 5 min); continue with the rest.
 *   HttpError permanent  → that row backs off slowly (1 min … 1 h); continue. A batch that
 *                          is rejected is retried row by row, so one bad record can never
 *                          block the queue.
 *   409 Conflict         → the server already has it; treated as success.
 *   410 Gone             → the server will never take it (e.g. monitoring was switched
 *                          off); dropped, like a success, so it cannot clog the queue.
 *
 * Only one cycle runs at a time; requests made during a cycle schedule one follow-up.
 */

const log = createLogger('sync')

export interface SyncHooks {
  client(): ApiClient | null
  employeeId(): string | null
  onAuthExpired(): void
  onChange(): void
}

export class SyncEngine {
  online = true
  syncing = false
  lastError: string | null = null

  private interval: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private rerunRequested = false
  private running = false
  /** First error message seen in the current cycle (surfaced to the UI at cycle end). */
  private cycleError: string | null = null
  /** The HttpError from the most recent failed attempt(), if any. */
  private lastFailure: HttpError | null = null

  constructor(private readonly hooks: SyncHooks) {}

  get lastSyncAt(): string | null {
    return kvGet<string>(KvKey.LastSyncAt)
  }

  /** Starts periodic syncing (and runs one cycle now). */
  start(): void {
    this.stop()
    this.running = true
    this.interval = setInterval(() => void this.run(), getConfig().syncIntervalSeconds * 1000)
    void this.run()
  }

  /** Stops scheduling new cycles. A cycle already in flight finishes on its own. */
  stop(): void {
    this.running = false
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.interval = null
    this.debounce = null
  }

  /** Requests a cycle soon, coalescing bursts (e.g. several screenshots at once). */
  trigger(delayMs = 3_000): void {
    if (!this.running || this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.run()
    }, delayMs)
  }

  /** Uploads everything now, ignoring backoff; resolves when that cycle completes. */
  async syncNow(): Promise<void> {
    const emp = this.hooks.employeeId()
    if (emp) resetBackoff(emp)
    if (this.inFlight) await this.inFlight
    await this.run()
  }

  /** Waits for an in-flight cycle, bounded by `timeoutMs` (used at shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([this.syncNow(), new Promise<void>((r) => setTimeout(r, timeoutMs))])
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    log.info(online ? 'Back online' : 'Offline')
    if (online) {
      const emp = this.hooks.employeeId()
      if (emp) resetBackoff(emp)
      this.trigger(500)
    }
    this.hooks.onChange()
  }

  /** Records a successful server contact (used when there was nothing to upload). */
  markContact(): void {
    kvSet(KvKey.LastSyncAt, new Date().toISOString())
    this.setOnline(true)
  }

  // ------------------------------------------------------------------ cycle

  private run(): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true
      return this.inFlight
    }
    this.inFlight = this.cycle().finally(() => {
      this.inFlight = null
      if (this.rerunRequested) {
        this.rerunRequested = false
        this.trigger(500)
      }
    })
    return this.inFlight
  }

  private async cycle(): Promise<void> {
    const client = this.hooks.client()
    const emp = this.hooks.employeeId()
    if (!client || !emp) return

    this.syncing = true
    this.cycleError = null
    this.hooks.onChange()
    try {
      await this.uploadSessions(client, emp)
      await this.uploadActivity(client, emp)
      await this.uploadScreenshots(client, emp)
      await this.uploadAlerts(client, emp)
      this.lastError = this.cycleError
    } catch (e) {
      if (e instanceof NetworkError) {
        this.setOnline(false)
      } else if (e instanceof AuthError) {
        this.hooks.onAuthExpired()
      } else {
        log.error('Unexpected sync failure', e)
        this.lastError = (e as Error).message
      }
    } finally {
      this.syncing = false
      this.hooks.onChange()
    }
  }

  private succeeded(): void {
    kvSet(KvKey.LastSyncAt, new Date().toISOString())
    this.setOnline(true)
  }

  /**
   * Runs one upload. Returns true on success (or 409). On an HTTP error, records it on the
   * rows and returns false. Network/auth errors propagate and abort the cycle.
   */
  private async attempt(rows: OutboxRow[], upload: () => Promise<unknown>): Promise<boolean> {
    try {
      await upload()
      return true
    } catch (e) {
      if (!(e instanceof HttpError)) throw e
      if (e.status === 409) return true
      if (e.status === 410) {
        log.warn(`Server discarded ${rows.length} ${rows[0]?.kind} row(s): ${e.message}`)
        return true
      }
      this.lastFailure = e
      log.warn(`Upload rejected (${e.status}) for ${rows.length} ${rows[0]?.kind} row(s): ${e.message}`)
      this.cycleError ??= e.message
      for (const r of rows) markFailed(r.id, `${e.status}: ${e.message}`, e.retryable)
      return false
    }
  }

  private async uploadSessions(client: ApiClient, emp: string): Promise<void> {
    for (const row of dueItems(emp, 'session', 50)) {
      const payload = JSON.parse(row.payload) as SessionPayload
      if (await this.attempt([row], () => client.upsertSession(payload))) {
        // Version check: if the session changed during upload, the newer row stays queued.
        remove(row.id, row.version)
        this.succeeded()
      }
    }
  }

  private async uploadActivity(client: ApiClient, emp: string): Promise<void> {
    const batchSize = getConfig().activityBatchSize
    // Bounded loop: at most 50 batches per cycle so a huge backlog can't monopolise it.
    for (let i = 0; i < 50; i++) {
      const rows = dueItems(emp, 'activity', batchSize)
      if (rows.length === 0) return
      const ok = await this.uploadActivityRows(client, rows)
      if (!ok && this.lastFailure?.retryable) return // server-side trouble; try again next cycle
      if (!ok && rows.length > 1) {
        // Isolate the bad record(s): undo the batch-wide backoff, then retry row by row so
        // only the rows the server actually rejects are held back.
        for (const r of rows) restoreAttempts(r)
        for (const row of rows) await this.uploadActivityRows(client, [row])
      }
      this.hooks.onChange()
      if (rows.length < batchSize) return
    }
  }

  private async uploadActivityRows(client: ApiClient, rows: OutboxRow[]): Promise<boolean> {
    const logs = rows.map((r) => JSON.parse(r.payload) as ActivityLogPayload)
    if (!(await this.attempt(rows, () => client.uploadActivity(logs)))) return false
    for (const r of rows) remove(r.id)
    this.succeeded()
    return true
  }

  private async uploadScreenshots(client: ApiClient, emp: string): Promise<void> {
    for (const row of dueItems(emp, 'screenshot', 20)) {
      const meta = JSON.parse(row.payload) as { id: string; sessionId: string; capturedAt: string }
      let image: Buffer
      try {
        image = readPendingImage(row.file_path ?? '')
      } catch (e) {
        // Missing or undecryptable (e.g. OS profile reset): nothing recoverable to send.
        log.error(`Discarding unreadable screenshot ${row.id}`, e)
        remove(row.id)
        deletePendingFile(row.file_path)
        continue
      }
      const sent = await this.attempt([row], () =>
        client.uploadScreenshot({ ...meta, mimeType: 'image/jpeg', imageBase64: image.toString('base64'), ...previewOf(image) })
      )
      if (sent) {
        remove(row.id)
        deletePendingFile(row.file_path)
        this.succeeded()
      }
      this.hooks.onChange()
    }
  }

  private async uploadAlerts(client: ApiClient, emp: string): Promise<void> {
    for (const row of dueItems(emp, 'alert', 20)) {
      const payload = JSON.parse(row.payload) as AlertPayload
      if (await this.attempt([row], () => client.sendAlert(payload))) {
        remove(row.id)
        this.succeeded()
      }
    }
  }
}
