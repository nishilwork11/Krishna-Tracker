import { uIOhook } from 'uiohook-napi'
import { createLogger } from '../platform/logger'

/**
 * System-wide input activity counter.
 *
 * PRIVACY: the event handlers below only increment counters. They never read the key
 * code, character, modifier state or cursor position from the event, so typed content
 * cannot be recorded even by accident. Keep it that way: do not add fields from `e`.
 *
 * Implementation: uiohook-napi installs an OS-level hook (Windows: low-level keyboard/
 * mouse hooks; macOS: event tap, which requires Accessibility permission).
 */

const log = createLogger('input')

export interface InputCounts {
  clicks: number
  keys: number
  /** Epoch ms of the most recent input event in this window, or null if none. */
  lastInputAt: number | null
}

class InputMonitor {
  private clicks = 0
  private keys = 0
  private lastInputAt: number | null = null
  private started = false

  /** Installs the global hook. Returns false if the OS refused (treated as a permission issue). */
  start(): boolean {
    if (this.started) return true
    try {
      uIOhook.on('mousedown', () => {
        this.clicks++
        this.lastInputAt = Date.now()
      })
      uIOhook.on('keydown', () => {
        this.keys++
        this.lastInputAt = Date.now()
      })
      uIOhook.start()
      this.started = true
      log.info('Input hook started')
      return true
    } catch (e) {
      log.error('Input hook failed to start', e)
      uIOhook.removeAllListeners()
      return false
    }
  }

  stop(): void {
    if (!this.started) return
    try {
      uIOhook.stop()
    } catch (e) {
      log.warn('Input hook stop failed', e)
    }
    uIOhook.removeAllListeners()
    this.started = false
  }

  /** Returns the counts accumulated since the previous call and resets them. */
  take(): InputCounts {
    const out = { clicks: this.clicks, keys: this.keys, lastInputAt: this.lastInputAt }
    this.reset()
    return out
  }

  /** Discards counts (e.g. input made while paused must not leak into the next minute). */
  reset(): void {
    this.clicks = 0
    this.keys = 0
    this.lastInputAt = null
  }
}

/** One hook per process; uiohook itself is a process-wide singleton. */
export const inputMonitor = new InputMonitor()
