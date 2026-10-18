import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { enqueue, getItem, pendingStats } from '../data/outbox'
import { ApiClient } from '../platform/api-client'
import type { TrackerService } from '../core/tracker-service'
import { accuracyTest, gapTest, shotsFastTest, shotsRealTest } from './accuracy-tests'
import { API, check, log, SelfTestFailure, serverData, signIn, tapKeys, today, wait } from './test-kit'

/**
 * DEVELOPMENT-ONLY end-to-end checks against the mock server (scripts/mock-server.mjs).
 * Loaded only when !app.isPackaged && TRACKER_SELFTEST=1 (see index.ts).
 * Run all of them with `npm run test:e2e`. Each mode exits 0 on success, 1 on failure.
 *
 *   full     sign in → start → screenshot → key counting → minute rollover → pause/resume
 *            → stop → upload → read back from server
 *   offline  server unreachable: everything stays queued, then drains on reconnect
 *   crash    leaves an ACTIVE session and kills the process (run `recover` next)
 *   recover  verifies the crashed session reached the server as INTERRUPTED
 *   poison   a record the server rejects must not block valid records, and must be reported
 *   accuracy known key presses at known times → exact counts, ACTIVE/INACTIVE, pause/resume edges
 *   gap      clock set back / 5 min sleep / 40 min sleep → timer, UNTRACKED, INTERRUPTED
 *   shots-fast  screenshot delays within range, randomised, none while paused, no catch-up burst
 *   shots-real  the real 8–12 min screenshot timing (≈20–25 min; `npm run test:shots-real`)
 *   hrms-clock the timer follows the HRMS clock: break pauses, resume resumes, check-out stops
 *   ui       saves PNGs of the main screens to SELFTEST_OUT for visual review
 */

export async function runSelfTest(svc: TrackerService, win: BrowserWindow | null): Promise<void> {
  const mode = process.env.SELFTEST_MODE || 'full'
  try {
    if (mode === 'full') await fullTest(svc)
    else if (mode === 'offline') await offlineTest(svc)
    else if (mode === 'crash') return await crashTest(svc)
    else if (mode === 'recover') await recoverTest(svc)
    else if (mode === 'poison') await poisonTest(svc)
    else if (mode === 'accuracy') await accuracyTest(svc)
    else if (mode === 'gap') await gapTest(svc)
    else if (mode === 'shots-fast') await shotsFastTest(svc)
    else if (mode === 'shots-real') await shotsRealTest(svc)
    else if (mode === 'hrms-clock') await hrmsClockTest(svc)
    else if (mode === 'ui') await uiSnapshot(svc, win!)
    else throw new SelfTestFailure(`unknown SELFTEST_MODE ${mode}`)
    log(`PASS (${mode})`)
    // Stop the native input hook and capture timers first; exiting with them live can abort.
    await svc.shutdown('COMPLETED', false).catch(() => undefined)
    app.exit(0)
  } catch (e) {
    console.error('[selftest] FAIL:', e instanceof SelfTestFailure ? e.message : e)
    app.exit(1)
  }
}

/** Sets the HRMS clock the mock server reports from /api/tracker/me. */
async function setMockClock(value: 'working' | 'break' | 'off'): Promise<void> {
  const res = await fetch(`${API}/admin/clock?value=${value}`, { method: 'POST' })
  check(res.ok, `could not set the mock clock to ${value}`)
}

async function hrmsClockTest(svc: TrackerService): Promise<void> {
  await setMockClock('working')
  try {
    await signIn(svc)
    check((await svc.start()).ok, 'start while checked in')
    const sessionId = svc.getState().sessionId!

    await setMockClock('break')
    await svc.checkPermission()
    check(svc.getState().sessionStatus === 'PAUSED', 'a break in the HRMS did not pause the timer')
    check(svc.getState().hrmsClock === 'break', 'hrmsClock not reported as break')
    svc.resume()
    check(svc.getState().sessionStatus === 'PAUSED', 'Resume in the app overrode the HRMS break')
    log('✔ break in the HRMS pauses the timer, and the app cannot resume over it')

    await setMockClock('working')
    await svc.checkPermission()
    check(svc.getState().sessionStatus === 'ACTIVE', 'ending the HRMS break did not resume the timer')
    log('✔ resuming in the HRMS resumes the timer')

    svc.pause()
    await svc.checkPermission()
    check(svc.getState().sessionStatus === 'PAUSED', "the HRMS resumed a pause the employee made")
    svc.resume()
    log("✔ the employee's own pause is left alone")

    await setMockClock('off')
    await svc.checkPermission()
    check(svc.getState().sessionStatus === null, 'checking out in the HRMS did not stop the timer')
    await svc.sync.syncNow()
    const server = (await serverData()).sessions.find((s) => s.id === sessionId)
    check(server?.status === 'COMPLETED', `server has the session as ${server?.status}`)
    log('✔ checking out in the HRMS stops the timer, and the session reaches the server COMPLETED')

    check(!(await svc.start()).ok, 'the timer started while checked out')
    log('✔ the timer cannot start while checked out')
  } finally {
    await setMockClock('working')
  }
}

async function fullTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  const started = await svc.start()
  check(started.ok, `start: ${started.error}`)
  const sessionId = svc.getState().sessionId!
  log('session', sessionId)

  await svc.screenshots.captureNow()
  // Synthetic F24 presses prove the global hook counts real OS key events.
  await tapKeys(5)

  const secs = 60 - new Date().getSeconds() + 2
  log(`waiting ${secs}s to cross a minute boundary…`)
  await wait(secs * 1000)

  svc.pause()
  check(svc.getState().sessionStatus === 'PAUSED', 'pause did not take effect')
  await wait(2000)
  svc.resume()
  await wait(2000)
  check(svc.getState().elapsedMs > 0, 'timer did not advance')

  svc.stop()
  await svc.sync.syncNow()
  await svc.sync.syncNow()

  const s = svc.getState()
  check(s.sessionStatus === null, 'session still open after stop')
  check(pendingStats(s.user!.id).count === 0, `queue not drained (${s.pendingCount} left, lastError=${s.lastError})`)

  const view = await svc.getActivity(today())
  const mine = view.logs.filter((l) => l.sessionId === sessionId)
  const keys = mine.reduce((n, l) => n + l.keyboardEventCount, 0)
  log(`server: ${mine.length} activity logs, ${keys} key events, ${view.screenshots.length} screenshots today`)
  check(mine.length >= 2, 'expected ≥2 activity logs for the session')
  check(keys >= 5, 'expected the 5 synthetic key presses to be counted')
  check(view.screenshots.length >= 1, 'expected ≥1 screenshot on the server')
  const img = await svc.getScreenshotImage(view.screenshots[0].id, false)
  check(img?.startsWith('data:image/jpeg;base64,'), 'could not download screenshot image')
}

async function offlineTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  // Swap in a client pointing at a closed port (test-only access to a private field).
  const internals = svc as unknown as { client: ApiClient; auth: { token: string } }
  const realClient = internals.client
  internals.client = new ApiClient('http://127.0.0.1:9', internals.auth.token)

  const started = await svc.start()
  check(started.ok, `start while offline: ${started.error}`)
  await svc.screenshots.captureNow()
  await wait(1500)
  svc.stop()
  await svc.sync.syncNow()
  let s = svc.getState()
  log(`offline: online=${s.online} pending=${s.pendingCount}`)
  check(!s.online, 'should report offline')
  check(s.pendingCount >= 3, 'session + activity + screenshot should stay queued')

  internals.client = realClient
  await svc.sync.syncNow()
  s = svc.getState()
  log(`reconnected: online=${s.online} pending=${s.pendingCount}`)
  check(s.online && s.pendingCount === 0, 'queue did not drain after reconnecting')
}

async function poisonTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  await svc.start()
  const { sessionId, user } = svc.getState()
  // A record the server will reject (invalid status), queued ahead of the real ones.
  const badId = randomUUID()
  const now = Date.now()
  enqueue({
    id: badId,
    employeeId: user!.id,
    kind: 'activity',
    sessionId,
    payload: {
      id: badId,
      sessionId,
      intervalStart: new Date(now - 60_000).toISOString(),
      intervalEnd: new Date(now - 30_000).toISOString(),
      mouseClickCount: 0,
      keyboardEventCount: 0,
      status: 'BOGUS'
    }
  })
  await wait(1500)
  svc.stop() // queues a valid activity row + final session state
  await svc.sync.syncNow()

  const s = svc.getState()
  const bad = getItem(badId)
  log(`pending=${s.pendingCount} lastError=${s.lastError} badAttempts=${bad?.attempts}`)
  check(bad && bad.attempts >= 1 && bad.next_attempt_at > Date.now(), 'rejected row should be kept with backoff')
  check(s.pendingCount === 1, 'only the rejected row should remain queued')
  check(s.lastError?.includes('status'), 'rejection should be reported to the UI')
}

async function crashTest(svc: TrackerService): Promise<void> {
  await signIn(svc)
  await svc.start()
  log('session', svc.getState().sessionId, '— waiting for a heartbeat, then killing the process')
  await wait(17_000)
  process.kill(process.pid, 'SIGKILL')
}

async function recoverTest(svc: TrackerService): Promise<void> {
  const s = svc.getState()
  check(s.notice?.includes('ended unexpectedly'), 'no recovery notice')
  check(s.sessionStatus === null, 'session should not still be open')
  await svc.sync.syncNow()
  const data = (await (await fetch(`${API}/admin/data.json`)).json()) as {
    sessions: Array<{ id: string; status: string; endedAt: string | null }>
    alerts: Array<{ type: string }>
  }
  const last = data.sessions[data.sessions.length - 1]
  log(`server session ${last.id}: ${last.status}, endedAt ${last.endedAt}`)
  check(last.status === 'INTERRUPTED' && last.endedAt, 'expected INTERRUPTED with endedAt on the server')
  check(data.alerts.some((a) => a.type === 'SESSION_INTERRUPTED'), 'expected a SESSION_INTERRUPTED alert')
}

async function uiSnapshot(svc: TrackerService, win: BrowserWindow): Promise<void> {
  const out = process.env.SELFTEST_OUT || '.'
  const shot = async (name: string): Promise<void> => {
    await wait(1500)
    writeFileSync(join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG())
    log('saved', name)
  }
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
  await shot('1-login')
  await signIn(svc)
  await svc.start()
  await svc.screenshots.captureNow()
  await wait(2000)
  await shot('2-tracker')
  await svc.sync.syncNow()
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.tab')].find((b) => b.textContent.includes('activity')).click()`
  )
  await wait(2500)
  await shot('3-activity')
  svc.stop()
  await svc.sync.syncNow()
}
