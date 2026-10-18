import { desktopCapturer, nativeImage, screen } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { basename, isAbsolute, join } from 'path'
import { enqueue, pendingStats, referencedFiles } from '../data/outbox'
import { getConfig } from '../platform/config'
import { createLogger } from '../platform/logger'
import { paths } from '../platform/paths'
import { decryptBuffer, encryptBuffer } from '../platform/secure-storage'

/**
 * Periodic screenshots while a session is ACTIVE.
 *
 * - Interval is random within [screenshotMinMinutes, screenshotMaxMinutes] (8–12 min by
 *   default) so captures can't be anticipated.
 * - A missed deadline (sleep, pause) is never "caught up": after resuming, a single new
 *   random delay is scheduled.
 * - One JPEG per display. Each is encrypted to disk and queued; the uploader deletes the
 *   file after the server confirms it.
 * - Skipped while the screen is locked (it would only capture the lock screen) and when
 *   the local storage cap is reached.
 */

const log = createLogger('screenshots')

/** Width of the preview sent with each upload for the HRMS admin grid. */
const THUMB_WIDTH = 480

export type StorageLevel = 'ok' | 'warn' | 'full'

export interface ScreenshotHooks {
  /** Who/what to attribute captures to; null when no ACTIVE session. */
  context(): { employeeId: string; sessionId: string } | null
  isScreenLocked(): boolean
  onCaptured(): void
  /** Called after each capture attempt with whether the OS allowed screen capture. */
  onPermission(ok: boolean): void
  onStorageLevel(level: StorageLevel): void
}

export class ScreenshotService {
  private timer: NodeJS.Timeout | null = null
  private capturing = false

  constructor(private readonly hooks: ScreenshotHooks) {}

  /** (Re)starts the random schedule. Safe to call repeatedly. */
  start(): void {
    this.stop()
    const { screenshotMinMinutes: min, screenshotMaxMinutes: max } = getConfig()
    const delayMs = (min + Math.random() * (max - min)) * 60_000
    this.timer = setTimeout(() => {
      this.timer = null
      void this.captureNow().finally(() => {
        // Keep the chain going only while a session is still active.
        if (this.hooks.context() && !this.timer) this.start()
      })
    }, delayMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Captures all displays immediately (if a session is active and conditions allow). */
  async captureNow(): Promise<void> {
    if (this.capturing) return
    const ctx = this.hooks.context()
    if (!ctx) return
    if (this.hooks.isScreenLocked()) {
      log.debug('Screen locked; skipping capture')
      return
    }
    const level = storageLevel()
    this.hooks.onStorageLevel(level)
    if (level === 'full') {
      log.warn('Local storage cap reached; skipping capture')
      return
    }

    this.capturing = true
    try {
      await this.captureAll(ctx)
    } catch (e) {
      log.error('Capture failed', e)
      this.hooks.onPermission(false)
    } finally {
      this.capturing = false
    }
  }

  private async captureAll(ctx: { employeeId: string; sessionId: string }): Promise<void> {
    const cfg = getConfig()
    // Size thumbnails for the largest display; desktopCapturer keeps each screen's aspect ratio.
    const largest = screen
      .getAllDisplays()
      .reduce((a, b) => (a.size.width * a.scaleFactor >= b.size.width * b.scaleFactor ? a : b))
    const physW = largest.size.width * largest.scaleFactor
    const physH = largest.size.height * largest.scaleFactor
    const scale = Math.min(1, cfg.screenshotMaxWidth / physW)

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(physW * scale), height: Math.round(physH * scale) }
    })
    // An empty thumbnail is how macOS reports missing Screen Recording permission.
    const usable = sources.filter((s) => !s.thumbnail.isEmpty())
    this.hooks.onPermission(usable.length > 0)
    if (usable.length === 0) {
      log.warn('No capturable screens (permission denied?)')
      return
    }

    const capturedAt = new Date().toISOString()
    for (const source of usable) {
      const jpeg = source.thumbnail.toJPEG(cfg.screenshotJpegQuality)
      const id = randomUUID()
      const fileName = `${id}.bin`
      const encrypted = encryptBuffer(jpeg)
      // File first, then queue row: a crash in between leaves an orphan file (cleaned at
      // startup), never a queue row pointing at a missing file.
      writeFileSync(join(paths.pendingScreenshots(), fileName), encrypted)
      enqueue({
        id,
        employeeId: ctx.employeeId,
        kind: 'screenshot',
        sessionId: ctx.sessionId,
        payload: { id, sessionId: ctx.sessionId, capturedAt },
        filePath: fileName,
        bytes: encrypted.length
      })
    }
    log.debug(`Captured ${usable.length} screen(s)`)
    this.hooks.onCaptured()
  }
}

// ------------------------------------------------------------------ file helpers

/** Resolves a queue `file_path` (file name; absolute paths from older versions also accepted). */
function resolvePending(file: string): string {
  return isAbsolute(file) ? file : join(paths.pendingScreenshots(), basename(file))
}

/**
 * The frame's size and a small JPEG preview, made at upload time so the queue format
 * stays unchanged. Best effort: a frame that will not decode uploads without them.
 */
export function previewOf(jpeg: Buffer): { thumbBase64?: string; width?: number; height?: number } {
  try {
    const image = nativeImage.createFromBuffer(jpeg)
    if (image.isEmpty()) return {}
    const { width, height } = image.getSize()
    const thumb = width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image
    return { thumbBase64: thumb.toJPEG(70).toString('base64'), width, height }
  } catch (e) {
    log.warn('Could not make a preview', e)
    return {}
  }
}

/** Decrypts a pending screenshot. Throws if the file is missing or corrupt. */
export function readPendingImage(file: string): Buffer {
  return decryptBuffer(readFileSync(resolvePending(file)))
}

export function deletePendingFile(file: string | null): void {
  if (!file) return
  const full = resolvePending(file)
  try {
    if (existsSync(full)) unlinkSync(full)
  } catch (e) {
    log.warn('Could not delete pending file', full, e)
  }
}

/** Storage level of everything waiting to upload, across all employees on this machine. */
export function storageLevel(): StorageLevel {
  const cfg = getConfig()
  const limit = cfg.storageLimitMb * 1024 * 1024
  const used = pendingStats(null).bytes
  if (used >= limit) return 'full'
  if (used >= limit * cfg.storageWarnRatio) return 'warn'
  return 'ok'
}

/** Deletes encrypted files no queue row references (left by a crash mid-capture/upload). */
export function cleanupOrphanFiles(): void {
  const known = new Set([...referencedFiles()].map((f) => basename(f)))
  let removed = 0
  for (const name of readdirSync(paths.pendingScreenshots())) {
    if (known.has(name)) continue
    try {
      unlinkSync(join(paths.pendingScreenshots(), name))
      removed++
    } catch {
      /* locked by AV scanner etc.; retry next launch */
    }
  }
  if (removed) log.info(`Removed ${removed} orphaned screenshot file(s)`)
}
