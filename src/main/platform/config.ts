import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createLogger } from './logger'
import { paths } from './paths'

/**
 * Application configuration.
 *
 * Precedence (lowest → highest):
 *   1. DEFAULTS below. The production server URL is baked in at build time from
 *      MAIN_VITE_HRMS_API_URL (see .env.example).
 *   2. <userData>/config.json, which IT can pre-provision, and which the app
 *      updates only with the server URL the employee signs in to.
 *   3. The capture cadence the HRMS reports (`screenshotsPerHour` from sign-in and
 *      /me). Held in memory only: the company setting is the source of truth.
 *   4. Developer overrides from environment variables (unpackaged builds only, so an
 *      employee cannot change capture behaviour on a production install).
 *
 * Every value is validated and clamped. A bad config.json can degrade to defaults but
 * can never put the app into an unsafe state (e.g. a 0-second screenshot interval).
 */

export interface AppConfig {
  apiBaseUrl: string
  screenshotMinMinutes: number
  screenshotMaxMinutes: number
  /** Screenshots wider than this are scaled down (keeps uploads well under server limits). */
  screenshotMaxWidth: number
  screenshotJpegQuality: number
  /** Hard cap on data waiting to upload. Screenshots stop being captured above it. */
  storageLimitMb: number
  /** Fraction of the cap at which the employee is warned and an admin alert is queued. */
  storageWarnRatio: number
  syncIntervalSeconds: number
  permissionCheckMinutes: number
  activityBatchSize: number
}

const log = createLogger('config')

const DEFAULTS: AppConfig = {
  apiBaseUrl: import.meta.env.MAIN_VITE_HRMS_API_URL || 'http://localhost:4000',
  screenshotMinMinutes: 8,
  screenshotMaxMinutes: 12,
  screenshotMaxWidth: 1600,
  screenshotJpegQuality: 60,
  storageLimitMb: 500,
  storageWarnRatio: 0.8,
  syncIntervalSeconds: 30,
  // Also how quickly a check-out or break in the HRMS reaches the timer.
  permissionCheckMinutes: 1,
  activityBatchSize: 200
}

/** [min, max] allowed for each numeric setting. */
const LIMITS: Record<Exclude<keyof AppConfig, 'apiBaseUrl'>, [number, number]> = {
  screenshotMinMinutes: [0.1, 120],
  screenshotMaxMinutes: [0.1, 240],
  screenshotMaxWidth: [640, 3840],
  screenshotJpegQuality: [30, 95],
  storageLimitMb: [50, 10_000],
  storageWarnRatio: [0.5, 0.95],
  syncIntervalSeconds: [5, 600],
  permissionCheckMinutes: [1, 60],
  activityBatchSize: [10, 500]
}

/** Values read from config.json (only known keys with the right type survive). */
let fileConfig: Partial<AppConfig> = {}
/** The cadence the server asked for; never written to config.json. */
let serverConfig: Partial<AppConfig> = {}
let effective: AppConfig | null = null

function readFileConfig(): Partial<AppConfig> {
  const file = paths.configFile()
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const out: Partial<AppConfig> = {}
    if (typeof raw.apiBaseUrl === 'string') out.apiBaseUrl = raw.apiBaseUrl
    for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key] as number
    }
    return out
  } catch (e) {
    log.warn('config.json is not valid JSON; using defaults', e)
    return {}
  }
}

/** Testing aid: TRACKER_SCREENSHOT_SECONDS=N → screenshot every ~N s (±25%), sync every 5 s. */
function devOverrides(): Partial<AppConfig> {
  if (app.isPackaged) return {}
  const out: Partial<AppConfig> = {}
  if (process.env.HRMS_API_URL) out.apiBaseUrl = process.env.HRMS_API_URL
  const seconds =
    Number(process.env.TRACKER_SCREENSHOT_SECONDS) || (process.env.TRACKER_FAST_SCREENSHOTS === '1' ? 20 : 0)
  if (seconds > 0) {
    out.screenshotMinMinutes = (seconds * 0.75) / 60
    out.screenshotMaxMinutes = (seconds * 1.25) / 60
    out.syncIntervalSeconds = 5
  }
  return out
}

function sanitize(c: AppConfig): AppConfig {
  const out = { ...c }
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const [min, max] = LIMITS[key]
    out[key] = Math.min(max, Math.max(min, out[key]))
  }
  if (out.screenshotMaxMinutes < out.screenshotMinMinutes) out.screenshotMaxMinutes = out.screenshotMinMinutes
  out.activityBatchSize = Math.round(out.activityBatchSize)
  out.apiBaseUrl = out.apiBaseUrl.trim().replace(/\/+$/, '')
  return out
}

export function getConfig(): AppConfig {
  if (!effective) {
    fileConfig = readFileConfig()
    effective = sanitize({ ...DEFAULTS, ...fileConfig, ...serverConfig, ...devOverrides() })
  }
  return effective
}

/**
 * Applies the HRMS's "screenshots per hour": captures land at random within ±25% of
 * the even spacing, so 6/hour means one every 7.5–12.5 minutes. Returns true when the
 * schedule changed (the caller restarts its capture timer).
 */
export function applyServerSchedule(screenshotsPerHour: number | undefined): boolean {
  if (typeof screenshotsPerHour !== 'number' || !Number.isFinite(screenshotsPerHour) || screenshotsPerHour <= 0) {
    return false
  }
  const spacing = 60 / screenshotsPerHour
  const next = { screenshotMinMinutes: spacing * 0.75, screenshotMaxMinutes: spacing * 1.25 }
  if (next.screenshotMinMinutes === serverConfig.screenshotMinMinutes && next.screenshotMaxMinutes === serverConfig.screenshotMaxMinutes) {
    return false
  }
  serverConfig = next
  effective = null
  return true
}

/**
 * Persists *only* the given keys to config.json. Runtime/dev overrides are never written,
 * so test settings cannot leak into the saved configuration.
 */
export function saveConfig(patch: Partial<Pick<AppConfig, 'apiBaseUrl'>>): void {
  getConfig()
  fileConfig = { ...fileConfig, ...patch }
  const file = paths.configFile()
  // Write-then-rename so a crash mid-write cannot leave a truncated config.json.
  writeFileSync(`${file}.tmp`, JSON.stringify(fileConfig, null, 2))
  renameSync(`${file}.tmp`, file)
  effective = null
}
