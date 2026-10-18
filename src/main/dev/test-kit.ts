import { existsSync, readFileSync } from 'fs'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { TrackerService } from '../core/tracker-service'
import { paths } from '../platform/paths'

/**
 * Shared helpers for the development self-tests (never bundled into behaviour of a
 * packaged app; see index.ts). Imported by selftest.ts and accuracy-tests.ts.
 */

export const API = process.env.HRMS_API_URL || 'http://localhost:4000'
const EMAIL = process.env.SELFTEST_EMAIL || 'alice@example.com'
const PASSWORD = process.env.SELFTEST_PASSWORD || 'password'

export const MINUTE = 60_000

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const log = (...a: unknown[]): void => console.log('[selftest]', ...a)

export class SelfTestFailure extends Error {}
export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SelfTestFailure(msg)
}

export async function signIn(svc: TrackerService): Promise<void> {
  const res = await svc.login(API, EMAIL, PASSWORD)
  check(res.ok, `login: ${res.error}`)
  // Regression: only the server URL may be persisted; dev/test overrides must never leak.
  if (existsSync(paths.configFile())) {
    const saved = Object.keys(JSON.parse(readFileSync(paths.configFile(), 'utf8')))
    check(saved.length === 1 && saved[0] === 'apiBaseUrl', `config.json contains unexpected keys: ${saved.join(', ')}`)
  }
}

export function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Sleeps until the wall clock reaches `epochMs`. */
export async function sleepUntil(epochMs: number): Promise<void> {
  const ms = epochMs - Date.now()
  if (ms > 0) await wait(ms)
}

/**
 * Sends `n` synthetic key presses. F24 is used because no physical keyboard has it and no
 * application reacts to it, so the tests never disturb whatever you are doing. (Do not
 * use Shift: five presses in a row triggers the Windows Sticky Keys prompt. Mouse clicks
 * cannot be synthesised safely, so mouse counting is not covered by automated tests.)
 */
export async function tapKeys(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    uIOhook.keyTap(UiohookKey.F24)
    await wait(60)
  }
}

/** Polls until `cond()` is true; fails the test after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs: number, label: string, pollMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    check(Date.now() < deadline, `timed out waiting for ${label}`)
    await wait(pollMs)
  }
}

/** Everything the mock server currently holds (see scripts/mock-server.mjs). */
export interface ServerData {
  sessions: Array<{
    id: string
    status: string
    startedAt: string
    endedAt: string | null
    pausedSeconds: number
    lastActivityAt: string | null
  }>
  activity: Array<{
    sessionId: string
    intervalStart: string
    intervalEnd: string
    mouseClickCount: number
    keyboardEventCount: number
    status: string
  }>
  alerts: Array<{ type: string }>
  screenshots: Array<{ id: string; sessionId: string; capturedAt: string }>
}

export async function serverData(): Promise<ServerData> {
  return (await (await fetch(`${API}/admin/data.json`)).json()) as ServerData
}

/**
 * Records when each screenshot-timer firing starts and finishes (including ones skipped,
 * e.g. screen locked). The scheduled delay before capture N is exactly
 * `starts[N] - ends[N-1]`; capture work itself (≈ a second) is not part of the delay.
 */
export function watchCaptures(svc: TrackerService): { starts: number[]; ends: number[] } {
  const rec = { starts: [] as number[], ends: [] as number[] }
  const original = svc.screenshots.captureNow.bind(svc.screenshots)
  svc.screenshots.captureNow = async (): Promise<void> => {
    rec.starts.push(Date.now())
    try {
      await original()
    } finally {
      rec.ends.push(Date.now())
    }
  }
  return rec
}

/**
 * TEST-ONLY observer of real (non-synthetic) input. The tracker counts every key and click
 * system-wide, so anything a person (or another program) does during a test is counted
 * too. Recording those events with timestamps lets the test compute exactly what each
 * interval SHOULD contain. It reads key codes, which the production input monitor never does.
 */
export interface NoiseEvent {
  t: number
  kind: 'key' | 'click'
}

export function watchNoise(): { events: NoiseEvent[] } {
  const rec = { events: [] as NoiseEvent[] }
  uIOhook.on('keydown', (e) => {
    if (e.keycode !== UiohookKey.F24) rec.events.push({ t: Date.now(), kind: 'key' })
  })
  uIOhook.on('mousedown', () => rec.events.push({ t: Date.now(), kind: 'click' }))
  return rec
}
