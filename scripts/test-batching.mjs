// Unit tests for when queued activity is uploaded: `npm run test:unit`. No Electron, server or database.
import assert from 'node:assert/strict'
import { activityUploadDue, heldForIdle } from '../src/main/core/batching.ts'

const MIN = 60_000
const HOLD = 5 * MIN
const T = Date.UTC(2026, 0, 1, 9, 0, 0)

const tests = {
  'nothing queued: nothing to send'() {
    assert.equal(activityUploadDue(null, T, HOLD, true, true), false)
  },
  'while tracking, waits until the oldest row is old enough'() {
    assert.equal(activityUploadDue(T, T + 4 * MIN + 59_000, HOLD, true, false), false)
    assert.equal(activityUploadDue(T, T + 5 * MIN, HOLD, true, false), true)
  },
  'sends everything as soon as the timer is paused or stopped'() {
    assert.equal(activityUploadDue(T, T + 1_000, HOLD, false, false), true)
  },
  'a forced sync (closing the app, back online) sends at once'() {
    assert.equal(activityUploadDue(T, T + 1_000, HOLD, true, true), true)
  },
  'batching off (0) sends every minute as before'() {
    assert.equal(activityUploadDue(T, T + 1_000, 0, true, false), true)
  },
  'recent no-input minutes are held while tracking, so an idle pause can take them back'() {
    const hold = 9 * MIN
    const row = (status, endMinAgo) => ({ status, intervalEnd: new Date(T - endMinAgo * MIN).toISOString() })
    assert.equal(heldForIdle(row('INACTIVE', 2), T, hold, true), true)
    assert.equal(heldForIdle(row('INACTIVE', 10), T, hold, true), false, 'old enough: never retracted')
    assert.equal(heldForIdle(row('ACTIVE', 2), T, hold, true), false, 'minutes with input are never held')
    assert.equal(heldForIdle(row('INACTIVE', 2), T, hold, false), false, 'paused or stopped: send all')
    assert.equal(heldForIdle(row('INACTIVE', 2), T, 0, true), false, 'idle check off: nothing held')
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exit(failed ? 1 : 0)
