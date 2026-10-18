// End-to-end test runner: `npm run test:e2e` (builds first).
//
// Starts the mock HRMS server on a private port, then runs the app's development
// self-tests (src/main/dev/selftest.ts) one after another, each against an isolated
// data folder so your real tracker profile is never touched.
//
// Note: the "full" test sends 5 harmless Shift key taps to verify global input counting,
// and screenshots of your screen are captured into the temporary test profile.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 4100
const API = `http://localhost:${PORT}`
const electronBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')

/**
 * Scenarios: [mode, expected exit code, extra env].
 * `crash` kills itself (exit code unchecked); `recover` must reuse crash's profile.
 * Default run = everything except `shots-real` (needs ~25 min; run it by name).
 * Usage: node scripts/run-e2e.mjs [mode ...]
 */
const ALL = {
  full: [0, {}],
  offline: [0, {}],
  crash: [null, {}],
  recover: [0, {}],
  poison: [0, {}],
  accuracy: [0, {}],
  gap: [0, {}],
  'shots-fast': [0, { TRACKER_SCREENSHOT_SECONDS: '10' }],
  'hrms-clock': [0, {}],
  'shots-real': [0, {}]
}
const requested = process.argv.slice(2)
const modes = requested.length ? requested : Object.keys(ALL).filter((m) => m !== 'shots-real')
for (const m of modes) {
  if (!ALL[m]) {
    console.error(`Unknown scenario "${m}". Choose from: ${Object.keys(ALL).join(', ')}`)
    process.exit(2)
  }
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const relay = (data) => {
      for (const line of data.toString().split(/\r?\n/)) if (line.includes('[selftest]')) console.log('   ', line.replace('[selftest] ', '').trim())
    }
    child.stdout.on('data', relay)
    child.stderr.on('data', relay)
    child.on('exit', (code) => resolve(code))
  })
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${API}/admin/data.json`)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('mock server did not start')
}

const server = spawn(process.execPath, [join(root, 'scripts', 'mock-server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore'
})

let failed = 0
const profile = mkdtempSync(join(tmpdir(), 'tracker-e2e-'))
try {
  await waitForServer()
  const env = { ...process.env, TRACKER_SELFTEST: '1', HRMS_API_URL: API, TRACKER_USER_DATA: profile }
  // VS Code and some shells set this, which would make Electron behave like plain Node.
  delete env.ELECTRON_RUN_AS_NODE

  for (const mode of modes) {
    const [expected, extraEnv] = ALL[mode]
    if (mode !== 'recover') rmSync(profile, { recursive: true, force: true })
    console.log(`▶ ${mode}`)
    const code = await run(electronBin, ['.'], { ...env, ...extraEnv, SELFTEST_MODE: mode })
    const ok = expected === null || code === expected
    console.log(ok ? `  ✔ ${mode}` : `  ✘ ${mode} (exit ${code})`)
    if (!ok) failed++
  }
} finally {
  server.kill()
  rmSync(profile, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} test(s) failed` : '\nAll end-to-end tests passed')
process.exit(failed ? 1 : 0)
