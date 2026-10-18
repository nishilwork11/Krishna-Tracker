import { screen } from 'electron'
import type { TrackerService } from '../core/tracker-service'
import { getConfig } from '../platform/config'
import {
  check,
  log,
  MINUTE,
  NoiseEvent,
  ServerData,
  serverData,
  signIn,
  sleepUntil,
  tapKeys,
  wait,
  waitFor,
  watchCaptures,
  watchNoise
} from './test-kit'

/**
 * Accuracy tests: do the recorded numbers match what actually happened?
 * Each one drives the real tracker with KNOWN input at KNOWN times and compares the data
 * that reaches the server against what it should be. Run via `npm run test:accuracy`
 * (accuracy, gap, shots-fast) or `npm run test:shots-real` (the real 8–12 minute timing).
 */

const ms = (iso: string): number => Date.parse(iso)
const fmt = (t: number): string => new Date(t).toLocaleTimeString([], { hour12: false })
const secs = (n: number): string => `${(n / 1000).toFixed(1)}s`
const mins = (n: number): string => `${Math.floor(n / MINUTE)}m ${Math.round((n % MINUTE) / 1000)}s`

function logsFor(data: ServerData, sessionId: string): ServerData['activity'] {
  return data.activity.filter((l) => l.sessionId === sessionId).sort((a, b) => ms(a.intervalStart) - ms(b.intervalStart))
}

// ============================================================================ accuracy

/**
 * Timeline (b0..b3 are consecutive wall-clock minute boundaries; session starts at b0+2s):
 *
 *   minute 0  7 key presses                                  → ACTIVE, 7 keys
 *   minute 1  nothing                                        → INACTIVE, 0 keys
 *   minute 2  4 presses, PAUSE at +20s, 9 presses while paused (must be ignored),
 *             RESUME at +35s, 3 presses                      → ACTIVE 4 keys, [15 s hole], ACTIVE 3 keys
 *   minute 3  STOP at +5s                                    → INACTIVE (5 s)
 */
export async function accuracyTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  log('note: real keyboard/mouse use during this ~4 min test is allowed; it is recorded and accounted for')
  const noise = watchNoise()
  const b0 = Math.floor(Date.now() / MINUTE) * MINUTE + MINUTE
  const [b1, b2, b3] = [b0 + MINUTE, b0 + 2 * MINUTE, b0 + 3 * MINUTE]
  log(`aligning to the next minute boundary (${secs(b0 + 2000 - Date.now())})…`)
  await sleepUntil(b0 + 2000)

  const started = await svc.start()
  check(started.ok, `start: ${started.error}`)
  const { sessionId, startedAt } = svc.getState()
  check(sessionId && startedAt, 'no session after start')

  await sleepUntil(b0 + 7_000)
  await tapKeys(7)
  log('minute 0: sent 7 key presses')

  await sleepUntil(b2 + 5_000)
  log('minute 1: sent nothing')
  await tapKeys(4)
  log('minute 2: sent 4 key presses')

  await sleepUntil(b2 + 20_000)
  const pauseFrom = Date.now()
  svc.pause()
  const pauseTo = Date.now()
  await sleepUntil(b2 + 22_000)
  await tapKeys(9)
  log('paused: sent 9 key presses (must NOT be counted)')

  await sleepUntil(b2 + 35_000)
  const resumeFrom = Date.now()
  svc.resume()
  const resumeTo = Date.now()
  await sleepUntil(b2 + 40_000)
  await tapKeys(3)
  log('resumed: sent 3 key presses')

  await sleepUntil(b3 + 5_000)
  const stopFrom = Date.now()
  svc.stop()
  const stopTo = Date.now()
  await svc.sync.syncNow()
  await svc.sync.syncNow()

  try {
    const data = await serverData()
    const logs = logsFor(data, sessionId)
    const session = data.sessions.find((s) => s.id === sessionId)
    check(session, 'session missing on server')

    log('─ what the server recorded ─')
    for (const l of logs) {
      log(`  ${fmt(ms(l.intervalStart))} → ${fmt(ms(l.intervalEnd))}  ${l.status.padEnd(8)} keys=${l.keyboardEventCount} clicks=${l.mouseClickCount}`)
    }

    // 1. Classification and counts, interval by interval. Expected count = key presses this
    //    test sent + real input that happened inside the interval (see noiseIn). Real events
    //    within TICK_SKEW of a minute boundary are ambiguous: the tracker samples once a second,
    //    so such an event may land in either neighbouring minute.
    check(logs.length === 5, `expected 5 activity intervals, got ${logs.length}`)
    const sent = [7, 0, 4, 3, 0] // synthetic key presses per interval (the 9 sent while paused belong to none)
    const startIsBoundary = [false, true, true, false, true]
    const endIsBoundary = [true, true, false, true, false]
    let extraKeys = 0
    let extraClicks = 0
    logs.forEach((l, i) => {
      const s0 = ms(l.intervalStart)
      const e0 = ms(l.intervalEnd)
      const key = noiseIn(noise.events, s0, e0, startIsBoundary[i], endIsBoundary[i], 'key')
      const click = noiseIn(noise.events, s0, e0, startIsBoundary[i], endIsBoundary[i], 'click')
      extraKeys += key.min
      extraClicks += click.min
      const note = `(sent ${sent[i]}, real keys ${key.min}${key.max > key.min ? `–${key.max}` : ''}, real clicks ${click.min}${click.max > click.min ? `–${click.max}` : ''})`
      check(
        l.keyboardEventCount >= sent[i] + key.min && l.keyboardEventCount <= sent[i] + key.max,
        `interval ${i}: recorded ${l.keyboardEventCount} key presses, expected ${sent[i] + key.min}–${sent[i] + key.max} ${note}`
      )
      check(
        l.mouseClickCount >= click.min && l.mouseClickCount <= click.max,
        `interval ${i}: recorded ${l.mouseClickCount} clicks, expected ${click.min}–${click.max} ${note}`
      )
      const mustBeActive = sent[i] + key.min + click.min > 0
      const mustBeInactive = sent[i] + key.max + click.max === 0
      check(!mustBeActive || l.status === 'ACTIVE', `interval ${i}: had input but was recorded ${l.status} ${note}`)
      check(!mustBeInactive || l.status === 'INACTIVE', `interval ${i}: had no input but was recorded ${l.status} ${note}`)
      log(`  interval ${i}: ${l.status}, ${l.keyboardEventCount} keys / ${l.mouseClickCount} clicks ✔ ${note}`)
    })
    log(`✔ every interval's count = key presses sent + real input inside it (${extraKeys} real keys, ${extraClicks} real clicks accounted for)`)
    log('✔ the 9 key presses sent while paused were not counted anywhere')

    // 2. Interval edges: minute rollovers are exact; pause/resume/stop land when they were pressed.
    const [l0, l1, l2, l3, l4] = logs
    check(ms(l0.intervalStart) === ms(startedAt!), 'first interval must start at the session start')
    check(ms(l0.intervalEnd) === b1 && ms(l1.intervalStart) === b1, 'minute 0/1 boundary must be exact')
    check(ms(l1.intervalEnd) === b2 && ms(l2.intervalStart) === b2, 'minute 1/2 boundary must be exact')
    check(ms(l2.intervalEnd) >= pauseFrom && ms(l2.intervalEnd) <= pauseTo, 'interval must end when Pause was pressed')
    check(ms(l3.intervalStart) >= resumeFrom && ms(l3.intervalStart) <= resumeTo, 'interval must start when Resume was pressed')
    check(ms(l3.intervalEnd) === b3 && ms(l4.intervalStart) === b3, 'minute 2/3 boundary must be exact')
    check(ms(l4.intervalEnd) >= stopFrom && ms(l4.intervalEnd) <= stopTo, 'last interval must end when Stop was pressed')
    log('✔ interval boundaries are exact (minute rollovers) or match the button presses (pause/resume/stop)')

    // 3. No overlaps, and the only hole is the pause.
    for (let i = 1; i < logs.length; i++) {
      const hole = ms(logs[i].intervalStart) - ms(logs[i - 1].intervalEnd)
      if (i === 3) check(Math.abs(hole - (resumeFrom - pauseFrom)) <= 100, `pause hole should be ${secs(resumeFrom - pauseFrom)}, was ${secs(hole)}`)
      else check(hole === 0, `unexpected hole/overlap of ${hole} ms before interval ${i}`)
    }
    const logged = logs.reduce((n, l) => n + ms(l.intervalEnd) - ms(l.intervalStart), 0)
    const expected = stopFrom - ms(startedAt!) - (resumeFrom - pauseFrom)
    check(Math.abs(logged - expected) <= 300, `logged time ${secs(logged)} should equal tracked time ${secs(expected)}`)
    log(`✔ no overlaps; logged ${secs(logged)} = wall time minus the ${secs(resumeFrom - pauseFrom)} pause`)

    // 4. Session record.
    check(session.status === 'COMPLETED', `session status should be COMPLETED, was ${session.status}`)
    check(Math.abs(session.pausedSeconds - (resumeFrom - pauseFrom) / 1000) <= 1, `pausedSeconds should be ≈15, was ${session.pausedSeconds}`)
    check(session.lastActivityAt && ms(session.lastActivityAt) > ms(startedAt!) && ms(session.lastActivityAt) < stopTo, 'lastActivityAt should be set')
    log(`✔ session: COMPLETED, paused ${session.pausedSeconds}s, last activity ${fmt(ms(session.lastActivityAt))}`)
  } finally {
    // Nothing to clean up; kept as a structural marker for the verification block above.
  }
}

/**
 * Real input inside (start, end] for one interval: `min` events are certainly counted in it,
 * `max` includes events that could belong to it or to its neighbour (± TICK_SKEW around a
 * minute boundary, ± a few ms around pause/resume/stop calls).
 */
const TICK_SKEW = 1500
const CALL_SKEW = 100
function noiseIn(
  events: NoiseEvent[],
  start: number,
  end: number,
  startIsBoundary: boolean,
  endIsBoundary: boolean,
  kind: NoiseEvent['kind']
): { min: number; max: number } {
  const ofKind = events.filter((e) => e.kind === kind).map((e) => e.t)
  const minLo = start + (startIsBoundary ? TICK_SKEW : CALL_SKEW)
  const minHi = end - (endIsBoundary ? 0 : CALL_SKEW)
  const maxLo = start - (startIsBoundary ? 0 : CALL_SKEW)
  const maxHi = end + (endIsBoundary ? TICK_SKEW : CALL_SKEW)
  return {
    min: ofKind.filter((t) => t > minLo && t <= minHi).length,
    max: ofKind.filter((t) => t >= maxLo && t <= maxHi).length
  }
}

// ============================================================================ gap

/**
 * Simulates the system clock behaving badly by shifting Date.now() (the tracker reads time
 * only through Date.now, so this is equivalent to the OS clock moving):
 *   1. clock set back 2 min      → timer stays continuous, session survives
 *   2. computer asleep for 5 min → logged UNTRACKED, not counted as work time, session continues
 *   3. asleep for 40 min         → session ends INTERRUPTED (over the 30 min limit) + alert
 */
export async function gapTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  const realNow = Date.now
  let offset = 0
  Date.now = (): number => realNow() + offset
  let sessionId = ''
  try {
    const started = await svc.start()
    check(started.ok, `start: ${started.error}`)
    sessionId = svc.getState().sessionId!
    await wait(2500)

    let before = svc.getState().elapsedMs
    offset = -2 * MINUTE
    svc.onResume()
    let after = svc.getState().elapsedMs
    log(`clock set back 2 min: timer ${secs(before)} → ${secs(after)}`)
    check(Math.abs(after - before) < 3000, 'timer must stay continuous when the clock moves back')
    check(svc.getState().sessionStatus === 'ACTIVE', 'session must survive a backwards clock change')

    await wait(1500)
    before = svc.getState().elapsedMs
    offset += 5 * MINUTE
    svc.onResume()
    after = svc.getState().elapsedMs
    log(`5 min sleep: timer ${secs(before)} → ${secs(after)} (sleep must not count as work)`)
    check(Math.abs(after - before) < 3000, 'sleep time must not be counted as tracked time')
    check(svc.getState().sessionStatus === 'ACTIVE', 'a 5 minute sleep must not end the session')

    await wait(1500)
    offset += 40 * MINUTE
    svc.onResume()
    const s = svc.getState()
    log(`40 min sleep: status=${s.sessionStatus}, notice="${s.notice}"`)
    check(s.sessionStatus === null, 'a sleep over 30 minutes must end the session')
    check(s.notice?.includes('interrupted'), 'employee must be told the session was interrupted')
  } finally {
    Date.now = realNow
  }

  await svc.sync.syncNow()
  await svc.sync.syncNow()
  const data = await serverData()
  const session = data.sessions.find((x) => x.id === sessionId)
  check(session?.status === 'INTERRUPTED' && session.endedAt, 'server should have the session as INTERRUPTED with an end time')
  check(data.alerts.some((a) => a.type === 'SESSION_INTERRUPTED'), 'admin alert SESSION_INTERRUPTED expected')

  const logs = logsFor(data, sessionId)
  const untracked = logs.filter((l) => l.status === 'UNTRACKED')
  log('─ what the server recorded ─')
  for (const l of logs) log(`  ${l.status.padEnd(9)} ${mins(ms(l.intervalEnd) - ms(l.intervalStart))}  keys=${l.keyboardEventCount}`)
  check(untracked.length === 1, `expected exactly one UNTRACKED interval, got ${untracked.length}`)
  const gap = ms(untracked[0].intervalEnd) - ms(untracked[0].intervalStart)
  check(gap >= 5 * MINUTE && gap < 5 * MINUTE + 3000, `UNTRACKED interval should be ≈5 min, was ${mins(gap)}`)
  check(untracked[0].keyboardEventCount === 0 && untracked[0].mouseClickCount === 0, 'untracked time must carry no counts')
  check(logs.every((l) => ms(l.intervalEnd) - ms(l.intervalStart) <= 6 * MINUTE), 'the 40 min sleep must not be logged as activity')
  log('✔ 5 min sleep → one UNTRACKED interval; 40 min sleep → INTERRUPTED with an alert and no fabricated activity')
}

// ============================================================================ screenshots

/**
 * Screenshot scheduling with SHORT intervals (needs TRACKER_SCREENSHOT_SECONDS, e.g. 10;
 * the runner sets it). The scheduler code path is identical to the real 8–12 minute one;
 * only the configured numbers differ.
 *   - every delay lies inside [min, max] and the delays vary (randomised)
 *   - no screenshot while paused
 *   - after resuming: exactly ONE screenshot after a fresh delay, never a catch-up burst
 */
export async function shotsFastTest(svc: TrackerService): Promise<void> {
  const cfg = getConfig()
  const minMs = cfg.screenshotMinMinutes * MINUTE
  const maxMs = cfg.screenshotMaxMinutes * MINUTE
  check(maxMs < MINUTE, 'run with TRACKER_SCREENSHOT_SECONDS (e.g. 10) so the intervals are short')
  const TOL = 400
  const inRange = (d: number): boolean => d >= minMs - TOL && d <= maxMs + TOL

  await signIn(svc)
  const rec = watchCaptures(svc)
  const tStart = Date.now()
  const started = await svc.start()
  check(started.ok, `start: ${started.error}`)
  const sessionId = svc.getState().sessionId!

  await waitFor(() => rec.ends.length >= 5, 120_000, '5 screenshots')
  const delays = rec.starts.slice(0, 5).map((t, i) => t - (i === 0 ? tStart : rec.ends[i - 1]))
  log(`allowed ${secs(minMs)}–${secs(maxMs)}; measured delays: ${delays.map(secs).join(', ')}`)
  check(delays.every(inRange), 'every screenshot delay must be inside the configured range')
  check(new Set(delays.map((d) => Math.round(d / 250))).size >= 2, 'delays should be randomised, but they were all the same')
  log('✔ delays are inside the range and randomised')

  // Pause for longer than two maximum intervals.
  svc.pause()
  await waitFor(() => rec.ends.length === rec.starts.length, 10_000, 'in-flight capture to finish')
  const beforePause = rec.starts.length
  await wait(maxMs * 2.5)
  check(rec.starts.length === beforePause, `a screenshot fired while paused (${rec.starts.length - beforePause})`)
  log(`✔ no screenshots during a ${secs(maxMs * 2.5)} pause (that is more than 2 missed deadlines)`)

  const tResume = Date.now()
  svc.resume()
  await waitFor(() => rec.starts.length > beforePause, maxMs + 6000, 'first screenshot after resume')
  const afterResume = rec.starts[beforePause] - tResume
  check(inRange(afterResume), `first screenshot after resume came after ${secs(afterResume)}, outside the range`)
  await wait(1000)
  check(rec.starts.length === beforePause + 1, 'catch-up burst: more than one screenshot after resume')
  log(`✔ after resume: exactly one screenshot, after a fresh ${secs(afterResume)} delay (no catch-up)`)

  svc.stop()
  await svc.sync.syncNow()
  await svc.sync.syncNow()
  const mine = (await serverData()).screenshots.filter((x) => x.sessionId === sessionId)
  const distinct = new Set(mine.map((x) => x.capturedAt)).size
  const displays = screen.getAllDisplays().length
  log(`server stored ${mine.length} image(s) from ${distinct} capture round(s); ${displays} display(s)`)
  check(distinct === rec.starts.length, `timer fired ${rec.starts.length}× but the server has ${distinct} capture round(s)`)
  check(mine.length >= distinct, 'every capture round must produce at least one image')
}

/**
 * The REAL thing: default 8–12 minute interval, two consecutive screenshots, timed.
 * Takes up to ~25 minutes. Keep the computer awake and the screen UNLOCKED (a locked
 * screen deliberately skips captures). Click and type normally while it runs and the
 * final summary will show your real activity counts.
 */
export async function shotsRealTest(svc: TrackerService): Promise<void> {
  const cfg = getConfig()
  check(cfg.screenshotMinMinutes === 8 && cfg.screenshotMaxMinutes === 12, 'must run with the default 8–12 min config (do not set TRACKER_SCREENSHOT_SECONDS)')
  const minMs = 8 * MINUTE
  const maxMs = 12 * MINUTE
  const TOL = 1500

  await signIn(svc)
  const rec = watchCaptures(svc)
  const tStart = Date.now()
  const started = await svc.start()
  check(started.ok, `start: ${started.error}`)
  const sessionId = svc.getState().sessionId!
  log(`session started ${fmt(tStart)}; waiting for 2 screenshots (each due 8–12 min after the previous event)…`)

  let lastReport = tStart
  while (rec.ends.length < 2) {
    check(Date.now() - tStart < 26 * MINUTE, 'no second screenshot within 26 minutes')
    await wait(5_000)
    if (Date.now() - lastReport >= MINUTE) {
      lastReport = Date.now()
      log(`  …${mins(Date.now() - tStart)} elapsed, ${rec.ends.length} screenshot(s) so far`)
    }
  }

  const d0 = rec.starts[0] - tStart
  const d1 = rec.starts[1] - rec.ends[0]
  log(`screenshot 1 at ${fmt(rec.starts[0])}: ${mins(d0)} after Start`)
  log(`screenshot 2 at ${fmt(rec.starts[1])}: ${mins(d1)} after screenshot 1`)
  check(d0 >= minMs - TOL && d0 <= maxMs + TOL, `first screenshot after ${mins(d0)} is outside 8–12 min`)
  check(d1 >= minMs - TOL && d1 <= maxMs + TOL, `second screenshot after ${mins(d1)} is outside 8–12 min`)
  log('✔ both screenshots arrived 8–12 minutes after the previous event')

  const stopAt = Date.now()
  svc.stop()
  await svc.sync.syncNow()
  await svc.sync.syncNow()
  const data = await serverData()
  const shots = data.screenshots.filter((x) => x.sessionId === sessionId)
  const distinct = new Set(shots.map((x) => x.capturedAt)).size
  check(distinct === 2, `expected exactly 2 capture rounds on the server, got ${distinct} (was the screen locked?)`)
  log(`✔ server holds ${shots.length} image(s) in ${distinct} capture rounds`)

  // Informational: what the tracker saw of the person actually using the computer.
  const logs = logsFor(data, sessionId)
  const sum = (status: string): number =>
    logs.filter((l) => l.status === status).reduce((n, l) => n + ms(l.intervalEnd) - ms(l.intervalStart), 0)
  const clicks = logs.reduce((n, l) => n + l.mouseClickCount, 0)
  const keys = logs.reduce((n, l) => n + l.keyboardEventCount, 0)
  log(`activity over ${mins(stopAt - tStart)}: ACTIVE ${mins(sum('ACTIVE'))}, INACTIVE ${mins(sum('INACTIVE'))}, UNTRACKED ${mins(sum('UNTRACKED'))}; ${clicks} mouse clicks, ${keys} key presses`)
}
