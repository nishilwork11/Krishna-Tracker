import { randomUUID } from 'crypto'
import type { ActivityLogPayload, ActivityStatus, SessionPayload, SessionStatus } from '@shared/api-contract'
import { KvKey, kvDelete, kvGet, kvSet } from '../data/kv-store'
import { enqueue, upsertSession } from '../data/outbox'
import { createLogger } from '../platform/logger'
import { inputMonitor } from './input-monitor'

/**
 * Work-session state machine and per-minute activity bucketing.
 *
 *            start()             pause()
 *   (none) ─────────▶ ACTIVE ◀───────────▶ PAUSED
 *                       │      resume()       │
 *                       └──── stop() ─────────┴──▶ COMPLETED / INTERRUPTED → (none)
 *
 * Activity is grouped into wall-clock minutes ("buckets"). When a minute ends, its click
 * and key counts are written to the outbox as one ActivityLog row:
 *   ACTIVE    = at least one input event in the interval
 *   INACTIVE  = no input
 *   UNTRACKED = the app could not observe input (machine asleep, hook unavailable)
 *
 * Invariants:
 *  - Every state change is persisted (kv `session`) before anything else happens, so a
 *    crash at any point is recoverable on next launch.
 *  - Activity intervals never overlap within a session unless the system clock is moved.
 *  - Nothing is uploaded from here; this class only writes to the local outbox.
 */

const log = createLogger('session')

const MINUTE_MS = 60_000
/** A tick arriving this much later than expected means the process was not running (sleep). */
const GAP_THRESHOLD_MS = 90_000
/** A gap longer than this ends the session as INTERRUPTED instead of bridging it. */
const INTERRUPT_AFTER_GAP_MS = 30 * MINUTE_MS
/** The clock moving back by more than this is treated as a manual time change. */
const CLOCK_BACK_TOLERANCE_MS = 5_000
/** Heartbeat persistence interval; bounds how much time a crash can lose. */
const PERSIST_EVERY_MS = 15_000
/** Intervals shorter than this are dropped (e.g. pause clicked right at a minute boundary). */
const MIN_INTERVAL_MS = 1_000

interface Bucket {
  start: number
  /** Exclusive end of the wall-clock minute this bucket belongs to. */
  minuteEnd: number
  clicks: number
  keys: number
}

/** Persisted shape of the live session (kv key `session`). All times are epoch ms. */
interface LiveSession {
  id: string
  employeeId: string
  /** HRMS project picked at Start. Optional: sessions saved by older versions have none. */
  projectId?: string | null
  startedAt: number
  status: 'ACTIVE' | 'PAUSED'
  /** Sum of completed pauses. */
  pausedMs: number
  /** Sum of bridged sleep gaps (excluded from tracked time). */
  untrackedMs: number
  /** Total backward clock adjustments, added back so the timer stays continuous. */
  clockAdjustMs: number
  pauseStartedAt: number | null
  lastActivityAt: number | null
  /** Heartbeat. After a crash, the session is closed at this instant. */
  lastTickAt: number
  bucket: Bucket | null
}

export interface SessionTrackerHooks {
  /** Any state change the UI should reflect. */
  onChange(): void
  /** Something was added to the outbox (trigger an upload soon). */
  onQueued(): void
  /** Session became ACTIVE (true) or stopped being ACTIVE (false). Drives screenshots. */
  onRunningChanged(running: boolean): void
  /** Message the employee should see (also shown as an OS notification). */
  notify(message: string): void
  /** Whether input counting currently works; if not, minutes are logged UNTRACKED. */
  inputAvailable(): boolean
}

const minuteEndOf = (t: number): number => Math.floor(t / MINUTE_MS) * MINUTE_MS + MINUTE_MS
const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString())

export class SessionTracker {
  private s: LiveSession | null
  private timer: NodeJS.Timeout | null = null
  private lastPersistAt = 0

  constructor(private readonly hooks: SessionTrackerHooks) {
    this.s = kvGet<LiveSession>(KvKey.Session)
    // Older persisted shapes may lack newer fields.
    if (this.s) this.s.clockAdjustMs ??= 0
  }

  /** The live session, or null. Read-only view for other services. */
  get current(): Readonly<Pick<LiveSession, 'id' | 'employeeId' | 'projectId' | 'status' | 'startedAt'>> | null {
    return this.s
  }

  // ================================================================== lifecycle

  /**
   * Must be called once at startup, before anything else. A persisted session means
   * the previous run ended without stopping it (crash, kill, power loss, forced update).
   * It is closed as INTERRUPTED at its last heartbeat. Returns true if that happened.
   */
  recoverAfterRestart(): boolean {
    const s = this.s
    if (!s) return false
    const endAt = Math.max(s.lastTickAt, s.startedAt)
    log.warn(`Recovering session ${s.id} as INTERRUPTED at ${new Date(endAt).toISOString()}`)
    if (s.status === 'ACTIVE' && s.bucket) this.flushBucket(s.bucket, Math.min(endAt, s.bucket.minuteEnd))
    if (s.status === 'PAUSED' && s.pauseStartedAt !== null) s.pausedMs += Math.max(0, endAt - s.pauseStartedAt)
    this.queueAlert('The desktop app was closed unexpectedly or the computer shut down.')
    this.finish('INTERRUPTED', endAt)
    return true
  }

  start(employeeId: string, projectId: string | null = null): void {
    if (this.s) return
    const now = Date.now()
    inputMonitor.reset()
    this.s = {
      id: randomUUID(),
      employeeId,
      projectId,
      startedAt: now,
      status: 'ACTIVE',
      pausedMs: 0,
      untrackedMs: 0,
      clockAdjustMs: 0,
      pauseStartedAt: null,
      lastActivityAt: null,
      lastTickAt: now,
      bucket: { start: now, minuteEnd: minuteEndOf(now), clicks: 0, keys: 0 }
    }
    this.persist(true)
    this.queueSession('ACTIVE')
    this.startTimer()
    log.info(`Session ${this.s.id} started`)
    this.hooks.onRunningChanged(true)
    this.hooks.onChange()
  }

  pause(): void {
    const s = this.s
    if (!s || s.status !== 'ACTIVE') return
    const now = Date.now()
    this.absorbInput()
    if (s.bucket) this.flushBucket(s.bucket, now)
    s.bucket = null
    s.status = 'PAUSED'
    s.pauseStartedAt = now
    this.persist(true)
    this.queueSession('PAUSED')
    this.hooks.onRunningChanged(false)
    this.hooks.onChange()
  }

  resume(): void {
    const s = this.s
    if (!s || s.status !== 'PAUSED') return
    const now = Date.now()
    if (s.pauseStartedAt !== null) s.pausedMs += Math.max(0, now - s.pauseStartedAt)
    s.pauseStartedAt = null
    s.status = 'ACTIVE'
    inputMonitor.reset() // input made while paused is not tracked
    s.bucket = { start: now, minuteEnd: minuteEndOf(now), clicks: 0, keys: 0 }
    this.persist(true)
    this.queueSession('ACTIVE')
    this.hooks.onRunningChanged(true)
    this.hooks.onChange()
  }

  /** Ends the session: COMPLETED for a normal stop, INTERRUPTED for shutdown/sleep/crash. */
  stop(status: 'COMPLETED' | 'INTERRUPTED' = 'COMPLETED', at = Date.now()): void {
    const s = this.s
    if (!s) return
    const wasRunning = s.status === 'ACTIVE'
    if (s.status === 'ACTIVE') {
      this.absorbInput()
      if (s.bucket) this.flushBucket(s.bucket, at)
    } else if (s.pauseStartedAt !== null) {
      s.pausedMs += Math.max(0, at - s.pauseStartedAt)
    }
    log.info(`Session ${s.id} stopped (${status})`)
    this.finish(status, at)
    if (wasRunning) this.hooks.onRunningChanged(false)
    this.hooks.onChange()
  }

  /** OS is about to sleep: flush and persist so the wake-up gap is measured precisely. */
  onSuspend(): void {
    if (!this.s) return
    this.tick()
    this.persist(true)
  }

  /** OS woke up: handle the gap now rather than on the next timer tick. */
  onResume(): void {
    if (this.s) this.tick()
  }

  /** Tracked time = wall time − pauses − bridged sleep gaps (+ clock corrections). */
  elapsedMs(now = Date.now()): number {
    const s = this.s
    if (!s) return 0
    const pausedNow = s.status === 'PAUSED' && s.pauseStartedAt !== null ? Math.max(0, now - s.pauseStartedAt) : 0
    return Math.max(0, now - s.startedAt + s.clockAdjustMs - s.pausedMs - pausedNow - s.untrackedMs)
  }

  /** Stops the internal timer (app shutdown). Does not end the session. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ================================================================== ticking

  private startTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1_000)
  }

  /** Runs every second: minute rollover, gap/clock detection, heartbeat. */
  private tick(): void {
    const s = this.s
    if (!s) return
    const now = Date.now()
    const delta = now - s.lastTickAt

    if (delta > GAP_THRESHOLD_MS) return this.handleGap(s.lastTickAt, now)
    if (delta < -CLOCK_BACK_TOLERANCE_MS) return this.handleClockMovedBack(now)

    if (s.status === 'ACTIVE' && s.bucket) {
      this.absorbInput()
      while (s.bucket && now >= s.bucket.minuteEnd) {
        const end: number = s.bucket.minuteEnd
        this.flushBucket(s.bucket, end)
        s.bucket = { start: end, minuteEnd: end + MINUTE_MS, clicks: 0, keys: 0 }
      }
    }
    s.lastTickAt = now
    this.persist(false)
  }

  /** The process did not run between `from` and `to` (sleep, hibernate, frozen VM). */
  private handleGap(from: number, to: number): void {
    const s = this.s!
    log.info(`Gap detected: ${Math.round((to - from) / 1000)}s`)
    if (s.status === 'ACTIVE' && s.bucket) {
      this.absorbInput()
      this.flushBucket(s.bucket, Math.min(from, s.bucket.minuteEnd))
    }

    if (to - from > INTERRUPT_AFTER_GAP_MS) {
      const wasRunning = s.status === 'ACTIVE'
      if (s.status === 'PAUSED' && s.pauseStartedAt !== null) s.pausedMs += Math.max(0, from - s.pauseStartedAt)
      this.queueAlert('The computer was asleep or unavailable for a long period.')
      this.finish('INTERRUPTED', from)
      this.hooks.notify('Your tracking session was interrupted while the computer was asleep. Start a new session to continue.')
      if (wasRunning) this.hooks.onRunningChanged(false)
      this.hooks.onChange()
      return
    }

    if (s.status === 'ACTIVE') {
      // Short gap: record it as untracked and carry on in the same session.
      this.queueLog(from, to, 0, 0, 'UNTRACKED')
      s.untrackedMs += to - from
      inputMonitor.reset()
      s.bucket = { start: to, minuteEnd: minuteEndOf(to), clicks: 0, keys: 0 }
      this.queueSession('ACTIVE')
    }
    s.lastTickAt = to
    this.persist(true)
    this.hooks.onChange()
  }

  /**
   * The system clock jumped backwards (manual change, NTP correction). Close the current
   * bucket at the last trustworthy instant and continue from the new clock reading.
   */
  private handleClockMovedBack(now: number): void {
    const s = this.s!
    const shift = s.lastTickAt - now
    log.warn(`System clock moved back by ${Math.round(shift / 1000)}s`)
    if (s.status === 'ACTIVE' && s.bucket) {
      this.absorbInput()
      this.flushBucket(s.bucket, Math.min(s.lastTickAt, s.bucket.minuteEnd))
      s.bucket = { start: now, minuteEnd: minuteEndOf(now), clicks: 0, keys: 0 }
    }
    if (s.pauseStartedAt !== null) s.pauseStartedAt -= shift
    s.clockAdjustMs += shift
    s.lastTickAt = now
    this.persist(true)
    this.hooks.onChange()
  }

  // ================================================================== recording

  /** Moves input counted since the last call into the current bucket. */
  private absorbInput(): void {
    const s = this.s
    const counts = inputMonitor.take()
    if (!s || !s.bucket) return
    s.bucket.clicks += counts.clicks
    s.bucket.keys += counts.keys
    if (counts.lastInputAt !== null) s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, counts.lastInputAt)
  }

  private flushBucket(b: Bucket, end: number): void {
    if (end - b.start < MIN_INTERVAL_MS) return
    const status: ActivityStatus = !this.hooks.inputAvailable()
      ? 'UNTRACKED'
      : b.clicks + b.keys > 0
        ? 'ACTIVE'
        : 'INACTIVE'
    this.queueLog(b.start, end, b.clicks, b.keys, status)
  }

  private queueLog(start: number, end: number, clicks: number, keys: number, status: ActivityStatus): void {
    const s = this.s!
    const untracked = status === 'UNTRACKED'
    const entry: ActivityLogPayload = {
      id: randomUUID(),
      sessionId: s.id,
      intervalStart: new Date(start).toISOString(),
      intervalEnd: new Date(end).toISOString(),
      mouseClickCount: untracked ? 0 : clicks,
      keyboardEventCount: untracked ? 0 : keys,
      status
    }
    enqueue({ id: entry.id, employeeId: s.employeeId, kind: 'activity', sessionId: s.id, payload: entry })
    this.hooks.onQueued()
  }

  private queueSession(status: SessionStatus, endedAt: number | null = null): void {
    const s = this.s!
    const payload: SessionPayload = {
      id: s.id,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: iso(endedAt),
      status,
      lastActivityAt: iso(s.lastActivityAt),
      pausedSeconds: Math.round(s.pausedMs / 1000),
      projectId: s.projectId ?? null
    }
    upsertSession(s.employeeId, s.id, payload)
    this.hooks.onQueued()
  }

  private queueAlert(reason: string): void {
    const s = this.s!
    const id = randomUUID()
    enqueue({
      id,
      employeeId: s.employeeId,
      kind: 'alert',
      sessionId: s.id,
      payload: { id, type: 'SESSION_INTERRUPTED', message: `Session ${s.id} was interrupted. ${reason}`, createdAt: new Date().toISOString() }
    })
  }

  /** Writes the final session state and clears the live session. */
  private finish(status: 'COMPLETED' | 'INTERRUPTED', at: number): void {
    const s = this.s!
    this.queueSession(status, Math.max(at, s.startedAt))
    this.s = null
    kvDelete(KvKey.Session)
    this.dispose()
  }

  private persist(force: boolean): void {
    if (!this.s) return
    const now = Date.now()
    if (!force && now - this.lastPersistAt < PERSIST_EVERY_MS) return
    this.lastPersistAt = now
    if (this.s.status === 'ACTIVE') this.absorbInput()
    kvSet(KvKey.Session, this.s)
  }
}
