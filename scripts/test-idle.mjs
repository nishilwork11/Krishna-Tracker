// Unit tests for the idle-detection state machine: `npm run test:idle`.
//
// Needs no Electron, server, network or database: the watcher gets a fake clock, a fake
// OS idle time and a fake card. Run with Node's TypeScript support (Node 22.7+).
import assert from 'node:assert/strict'
import { IdleWatcher } from '../src/main/core/idle-watcher.ts'

const MIN = 60_000
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0)
const SETTINGS = { enabled: true, promptMinutes: 5, responseMinutes: 3 }

/** A watcher plus the fake world around it. `idleFor(ms)` = no input since `world.lastInputAt`. */
function setup(overrides = {}) {
  const w = {
    now: T0,
    lastInputAt: T0,
    running: true,
    locked: false,
    cardWorks: true,
    settings: { ...SETTINGS },
    pauses: [],
    resumes: 0,
    notices: [],
    cards: []
  }
  Object.assign(w, overrides)
  const watcher = new IdleWatcher({
    isRunning: () => w.running,
    pause: (at) => {
      w.pauses.push(at)
      w.pausedWhen = w.now
      w.running = false
    },
    resume: () => {
      w.resumes++
      w.running = true
    },
    isScreenLocked: () => w.locked,
    notice: (m) => w.notices.push(m),
    idleSeconds: () => Math.floor((w.now - w.lastInputAt) / 1000),
    settings: () => w.settings,
    showPrompt: (opts) => {
      const card = { opts, shown: w.cardWorks, closed: false, close: () => (card.closed = true) }
      w.cards.push(card)
      return card
    }
  })
  /** Advance the clock by `ms` in 5 s polls, like the real timer. */
  const advance = (ms) => {
    for (let t = 0; t < ms; t += 5_000) {
      w.now += 5_000
      watcher.check(w.now)
    }
  }
  const input = () => (w.lastInputAt = w.now)
  watcher.check(w.now)
  return { w, watcher, advance, input }
}

const tests = {
  'does nothing while there is recent input'() {
    const { w, advance, input } = setup()
    for (let i = 0; i < 20; i++) {
      advance(MIN)
      input()
    }
    assert.equal(w.cards.length, 0)
    assert.equal(w.pauses.length, 0)
  },

  'asks after the quiet period, not before'() {
    const { w, advance } = setup()
    advance(4 * MIN + 55_000)
    assert.equal(w.cards.length, 0)
    advance(10_000)
    assert.equal(w.cards.length, 1)
    assert.equal(w.cards[0].opts.quiet, '5 minutes')
    assert.equal(w.cards[0].opts.deadline, w.now - 5_000 + 3 * MIN)
  },

  'clicking the card keeps the timer and does not nag again for a quiet period'() {
    const { w, advance } = setup()
    advance(5 * MIN + 5_000)
    w.cards[0].opts.onConfirm()
    assert.equal(w.cards[0].closed, true)
    advance(4 * MIN)
    assert.equal(w.cards.length, 1)
    assert.equal(w.pauses.length, 0)
  },

  'no answer: pauses from when the idleness began, and says so'() {
    const { w, advance } = setup()
    advance(5 * MIN + 5_000) // card appears
    advance(3 * MIN) // window runs out
    assert.equal(w.pauses.length, 1)
    assert.equal(w.pauses[0], T0, 'backdated to the last input')
    assert.equal(w.cards[0].closed, true)
    assert.equal(w.notices.length, 1)
  },

  'returning to the keyboard while asked closes the card and keeps the timer'() {
    const { w, advance, input } = setup()
    advance(5 * MIN + 5_000)
    advance(60_000)
    input()
    advance(5_000)
    assert.equal(w.cards[0].closed, true)
    advance(6 * MIN) // quiet again for a full stretch is a fresh question
    assert.equal(w.pauses.length, 0, 'the earlier quiet stretch was answered by coming back')
    assert.equal(w.cards.length, 2)
  },

  'a card that could not be shown never pauses the timer (fail open)'() {
    const { w, advance } = setup({ cardWorks: false })
    advance(5 * MIN + 5_000)
    advance(3 * MIN)
    assert.equal(w.pauses.length, 0, 'silence is not proof of absence')
    assert.equal(w.running, true)
    advance(2 * MIN)
    assert.equal(w.cards.length, 1, 'does not retry every poll')
  },

  'first input after an idle pause resumes the timer'() {
    const { w, advance, input } = setup()
    advance(5 * MIN + 5_000)
    advance(3 * MIN)
    assert.equal(w.running, false)
    advance(MIN)
    assert.equal(w.resumes, 0, 'stays paused while still away')
    input()
    advance(5_000)
    assert.equal(w.resumes, 1)
    assert.equal(w.running, true)
  },

  'a locked screen pauses straight away from when the idleness began, without a card'() {
    const { w, advance } = setup({ locked: true })
    advance(5 * MIN + 5_000)
    assert.equal(w.cards.length, 0)
    assert.deepEqual(w.pauses, [T0])
  },

  'switched off: never asks or pauses'() {
    const { w, advance } = setup({ settings: { ...SETTINGS, enabled: false } })
    advance(60 * MIN)
    assert.equal(w.cards.length, 0)
    assert.equal(w.pauses.length, 0)
  },

  'switching off while asked closes the card'() {
    const { w, advance } = setup()
    advance(5 * MIN + 5_000)
    w.settings.enabled = false
    advance(5_000)
    assert.equal(w.cards[0].closed, true)
    assert.equal(w.pauses.length, 0)
  },

  'does nothing while the timer is paused or stopped'() {
    const { w, advance } = setup({ running: false })
    advance(30 * MIN)
    assert.equal(w.cards.length, 0)
    assert.equal(w.pauses.length, 0)
  },

  'user pausing the timer by hand while asked closes the card'() {
    const { w, advance } = setup()
    advance(5 * MIN + 5_000)
    w.running = false
    advance(5_000)
    assert.equal(w.cards[0].closed, true)
    advance(10 * MIN)
    assert.equal(w.pauses.length, 0)
  },

  'after a card that could not be shown, a later pause reaches back only one question'() {
    const { w, advance } = setup({ cardWorks: false })
    advance(5 * MIN + 5_000) // first card fails to show: timer keeps running
    advance(3 * MIN)
    w.cardWorks = true
    advance(5 * MIN) // asked again after the snooze
    advance(3 * MIN) // and nobody answers
    assert.equal(w.pauses.length, 1)
    const back = w.pausedWhen - w.pauses[0]
    assert.ok(back <= 8 * MIN + 10_000, `backdated ${back / 1000}s, more than prompt + response`)
    assert.ok(back >= 8 * MIN, 'still covers the whole unanswered question')
  },

  'a long freeze (computer sleep) is not mistaken for idleness'() {
    const { w, watcher } = setup()
    w.now += 2 * 60 * MIN // slept two hours; OS idle time now claims 2 h
    watcher.check(w.now)
    assert.equal(w.cards.length, 0, 'no instant card on wake')
    assert.equal(w.pauses.length, 0)
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
