import { app, nativeImage, NativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

// Tray/window icons are drawn in code (no image assets to ship or keep in sync). The tray
// colour is the always-visible tracking indicator required by the plan: green = tracking,
// amber = paused, grey = idle, red = needs attention.

export type IconTone = 'active' | 'paused' | 'idle' | 'problem'

const colors: Record<IconTone, [number, number, number]> = {
  active: [34, 197, 94],
  paused: [245, 158, 11],
  idle: [148, 163, 184],
  problem: [239, 68, 68]
}

function drawBitmap(size: number, tone: IconTone): Buffer {
  const [r, g, b] = colors[tone]
  const buf = Buffer.alloc(size * size * 4)
  const c = (size - 1) / 2
  const outer = size / 2 - 0.5
  const ring = outer * 0.62
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      // Anti-aliased disc with a lighter centre dot (a "record" indicator).
      const a = Math.max(0, Math.min(1, outer - d + 0.5))
      const inner = Math.max(0, Math.min(1, ring * 0.55 - d + 0.5))
      const i = (y * size + x) * 4
      const mix = (v: number): number => Math.round(v + (255 - v) * inner * 0.85)
      buf[i] = mix(b) // BGRA
      buf[i + 1] = mix(g)
      buf[i + 2] = mix(r)
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return buf
}

const cache = new Map<string, NativeImage>()

export function trayIcon(tone: IconTone): NativeImage {
  const key = `tray-${tone}`
  if (!cache.has(key)) {
    const img = nativeImage.createFromBitmap(drawBitmap(16, tone), { width: 16, height: 16, scaleFactor: 1 })
    img.addRepresentation({ buffer: drawBitmap(32, tone), width: 32, height: 32, scaleFactor: 2 })
    cache.set(key, img)
  }
  return cache.get(key)!
}

export function appIcon(): NativeImage {
  if (!cache.has('app')) {
    const candidates = [
      join(app.getAppPath(), 'build', 'icon.png'),
      join(__dirname, '../../build/icon.png'),
      join(__dirname, '../../../build/icon.png')
    ]
    let iconImg: NativeImage | null = null
    for (const p of candidates) {
      if (existsSync(p)) {
        iconImg = nativeImage.createFromPath(p)
        break
      }
    }
    cache.set('app', iconImg && !iconImg.isEmpty() ? iconImg : nativeImage.createFromBitmap(drawBitmap(64, 'active'), { width: 64, height: 64 }))
  }
  return cache.get('app')!
}
