// Starts the app in dev mode with a short screenshot interval for testing.
// Usage: npm run dev:fast            → screenshot about every 20 s
//        npm run dev:fast -- 10      → screenshot about every 10 s
import { spawn } from 'node:child_process'

const seconds = Number(process.argv[2]) || 20
console.log(`Test mode: screenshot about every ${seconds}s, sync every 5s`)

const child = spawn('npx electron-vite dev', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TRACKER_SCREENSHOT_SECONDS: String(seconds) }
})
child.on('exit', (code) => process.exit(code ?? 0))
