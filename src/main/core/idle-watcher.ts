import type { IdlePrompt, IdlePromptOptions } from '../app/idle-prompt'

/**
 * "Are you still working?" — tells inactivity that is real from inactivity that is not.
 *
 *   watching ── idle ≥ prompt time ──▶ asked ── answered ──▶ snoozed ── prompt time ──▶ watching
 *       ▲                               │
 *       │ input returns                 └── no answer in time ──▶ session paused from when
 *       └──────────────────────────────────────────────────────  the idleness began
 *
 * Idleness is the OS-wide idle time (any mouse or keyboard input, anywhere on the computer),
 * so it holds wherever the employee is working. An answer is a click on the card or simply
 * coming back to the keyboard. A pause made here is lifted again by the first input, so
 * nobody has to open the HRMS to carry on.
 *
 * Never pauses on silence alone: the timer pauses only if the card was really on screen for
 * the whole response window. If it could not be shown the timer keeps running, because
 * someone reading, in a call, or waiting on a long task looks exactly like someone away.
 *
 * PRIVACY: only the idle duration is read; no input content is ever touched.
 *
 * Everything outside the state machine (clock, OS idle time, settings, the card) is passed in,
 * so scripts/test-idle.mjs can drive it without Electron.
 */

const POLL_MS = 5_000
/** A poll arriving this late means the process was frozen (sleep): the idle time cannot be trusted. */
const STALL_MS = POLL_MS * 3
/**
 * A pause is backdated at most prompt + response (+ this, for poll timing). Minutes queued before
 * that may already be on the server and could not be taken back; the uploader holds idle
 * minutes for prompt + response + 1 minute, which covers it (see activityHoldMs).
 */
const BACKDATE_SLACK_MS = POLL_MS * 2
type Phase = 'watching' | 'asked' | 'snoozed'

export interface IdleSettings {
  enabled: boolean
  promptMinutes: number
  responseMinutes: number
}

export interface IdleWatcherHooks {
  /** True while the timer is running. */
  isRunning(): boolean
  /** Pauses the timer as of `at` (epoch ms). */
  pause(at: number): void
  /** Lifts a pause this watcher made. */
  resume(): void
  isScreenLocked(): boolean
  /** Message to keep on screen in the app window (not an OS notification). */
  notice(message: string): void
  /** Seconds since the last keyboard or mouse input anywhere on the computer. */
  idleSeconds(): number
  settings(): IdleSettings
  /** Puts the question on screen. */
  showPrompt(opts: IdlePromptOptions): IdlePrompt
  log?: { info(msg: string): void; warn(msg: string): void }
}

export class IdleWatcher {
  private timer: NodeJS.Timeout | null = null
  private phase: Phase = 'watching'
  private askedAt = 0
  private snoozeUntil = 0
  private lastCheckAt = 0
  private pausedByIdle = false
  private prompt: IdlePrompt | null = null

  constructor(private readonly hooks: IdleWatcherHooks) {}

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.check(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.reset()
  }

  /** One look at the idle time. Public so tests can drive it without waiting. */
  check(now = Date.now()): void {
    const sincePrev = this.lastCheckAt > 0 ? now - this.lastCheckAt : POLL_MS
    const stalled = sincePrev > STALL_MS
    this.lastCheckAt = now
    const idleS = this.hooks.idleSeconds()

    if (this.pausedByIdle) {
      // Input since the previous poll means the idle clock restarted after it.
      if (idleS * 1000 <= sincePrev) this.welcomeBack()
      return
    }

    const { enabled, promptMinutes, responseMinutes } = this.hooks.settings()
    if (!enabled || !this.hooks.isRunning() || stalled) {
      this.reset()
      return
    }

    if (idleS < promptMinutes * 60) {
      // Back at the keyboard: that answers the question.
      this.reset()
      return
    }

    const idleSince = now - idleS * 1000

    if (this.phase === 'snoozed') {
      if (now >= this.snoozeUntil) this.phase = 'watching'
      else return
    }

    if (this.phase === 'watching') {
      // A locked screen cannot show the question; being away from a locked computer is its own answer.
      if (this.hooks.isScreenLocked()) return this.pauseFrom(idleSince, now, promptMinutes, responseMinutes)
      this.ask(now, promptMinutes, responseMinutes)
      return
    }

    // asked: the response window has run out with nobody back.
    if (now - this.askedAt < responseMinutes * 60_000) return
    if (this.prompt?.shown) return this.pauseFrom(idleSince, now, promptMinutes, responseMinutes)
    // The question never reached the employee. They may be reading or waiting on a long task,
    // so keep the timer running rather than punish silence.
    this.hooks.log?.warn('Idle card was not shown; leaving the timer running')
    this.snooze(now, promptMinutes)
  }

  // ================================================================== steps

  private ask(now: number, promptMinutes: number, responseMinutes: number): void {
    this.phase = 'asked'
    this.askedAt = now
    this.hooks.log?.info('Asking whether the employee is still working')
    this.closePrompt()
    this.prompt = this.hooks.showPrompt({
      deadline: now + responseMinutes * 60_000,
      quiet: minutesText(promptMinutes),
      onConfirm: () => this.answered()
    })
  }

  /** "I'm working": keep the timer, and ask again only after another quiet stretch. */
  private answered(): void {
    this.hooks.log?.info('Employee confirmed they are still working')
    this.snooze(Date.now(), this.hooks.settings().promptMinutes)
  }

  private snooze(now: number, promptMinutes: number): void {
    this.phase = 'snoozed'
    this.snoozeUntil = now + promptMinutes * 60_000
    this.closePrompt()
  }

  /**
   * Pauses as of when the idleness began, but never further back than this one question covers.
   * (After a card that could not be shown, the idleness may be much older than that.)
   */
  private pauseFrom(idleSince: number, now: number, promptMinutes: number, responseMinutes: number): void {
    const from = Math.max(idleSince, now - (promptMinutes + responseMinutes) * 60_000 - BACKDATE_SLACK_MS)
    this.hooks.log?.info(`No answer; pausing the timer from ${new Date(from).toISOString()}`)
    this.closePrompt()
    this.phase = 'watching'
    this.pausedByIdle = true
    this.hooks.pause(from)
    this.hooks.notice('Your timer was paused because there was no activity. It resumes as soon as you are back.')
  }

  private welcomeBack(): void {
    this.pausedByIdle = false
    this.reset()
    this.hooks.resume()
  }

  private reset(): void {
    this.phase = 'watching'
    this.closePrompt()
  }

  private closePrompt(): void {
    this.prompt?.close()
    this.prompt = null
  }
}

function minutesText(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} seconds`
  const n = Math.round(minutes)
  return `${n} minute${n === 1 ? '' : 's'}`
}
