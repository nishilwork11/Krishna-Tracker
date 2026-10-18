// In-memory stand-in for the HRMS tracker API (same contract as krishna-hrms src/app/api/tracker).
// For local development and testing only: node scripts/mock-server.mjs
//
// Demo accounts: alice@example.com / password, bob@example.com / password
// GET http://localhost:4000/admin shows what the server has received.
// MOCK_TRACKING_ALLOWED=0 makes /me report that tracking is not permitted.
// MOCK_CLOCK=working|break|off overrides the HRMS clock /me reports (break pauses the timer);
// POST /admin/clock?value=… changes it while running (used by the hrms-clock self-test).
// GET http://localhost:4000/admin/link?user=emp_alice returns a krishnatracker://start
// link with a single-use code, like "Start timer" in the HRMS.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const PORT = Number(process.env.PORT || 4000)
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

const users = [
  { id: 'emp_alice', name: 'Alice Johnson', email: 'alice@example.com', password: 'password' },
  { id: 'emp_bob', name: 'Bob Smith', email: 'bob@example.com', password: 'password' }
]
const tokens = new Map() // token -> { userId, expiresAt }
const sessions = new Map() // id -> session
const activity = new Map() // id -> log
const screenshots = new Map() // id -> { meta, image }
const alerts = []
const lastSeen = new Map() // userId -> iso
const linkCodes = new Map() // code -> { userId, expiresAt }
const SCREENSHOTS_PER_HOUR = Number(process.env.MOCK_SCREENSHOTS_PER_HOUR || 6)
let clockOverride = process.env.MOCK_CLOCK || null
const projects = [
  { id: 'prj_hrms', key: 'HRMS', name: 'HRMS Platform', color: 'violet' },
  { id: 'prj_web', key: 'WEB', name: 'Company Website', color: 'aqua' }
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function send(res, status, body, headers = {}) {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, headers)
    return res.end(body)
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readJson(req, limit = 5 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 })
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString()
  return raw ? JSON.parse(raw) : {}
}

function authUser(req) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  const t = token && tokens.get(token)
  if (!t || t.expiresAt < Date.now()) return null
  lastSeen.set(t.userId, new Date().toISOString())
  return users.find((u) => u.id === t.userId) || null
}

function dayRange(date, tz) {
  // date = YYYY-MM-DD in the employee's local time; tz = minutes east of UTC
  const start = Date.parse(`${date}T00:00:00Z`) - Number(tz || 0) * 60_000
  return [start, start + 86_400_000]
}

function isIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

const routes = []
const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

function signIn(res, u) {
  const token = randomBytes(24).toString('hex')
  const expiresAt = Date.now() + 30 * 86_400_000
  tokens.set(token, { userId: u.id, expiresAt })
  send(res, 200, {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    user: { id: u.id, name: u.name, email: u.email },
    trackingAllowed: process.env.MOCK_TRACKING_ALLOWED !== '0',
    screenshotsPerHour: SCREENSHOTS_PER_HOUR
  })
}

route('POST', /^\/api\/tracker\/auth\/login$/, async (req, res) => {
  const { email, password } = await readJson(req)
  const u = users.find((x) => x.email === String(email).toLowerCase() && x.password === password)
  if (!u) return send(res, 401, { error: 'Invalid email or password' })
  signIn(res, u)
})

route('POST', /^\/api\/tracker\/auth\/link$/, async (req, res) => {
  const { code } = await readJson(req)
  const entry = linkCodes.get(String(code))
  linkCodes.delete(String(code)) // single use
  const u = entry && entry.expiresAt > Date.now() && users.find((x) => x.id === entry.userId)
  if (!u) return send(res, 401, { error: 'That link has expired. Press Start timer in the HRMS again.' })
  signIn(res, u)
})

route('POST', /^\/api\/tracker\/auth\/logout$/, async (req, res) => {
  const h = req.headers.authorization || ''
  tokens.delete(h.replace('Bearer ', ''))
  send(res, 200, { ok: true })
})

route('GET', /^\/api\/tracker\/me$/, async (req, res, u) => {
  const clock = clockOverride || (process.env.MOCK_TRACKING_ALLOWED !== '0' ? 'working' : 'off')
  const allowed = clock === 'working'
  send(res, 200, {
    user: { id: u.id, name: u.name, email: u.email },
    trackingAllowed: allowed,
    clock,
    screenshotsPerHour: SCREENSHOTS_PER_HOUR,
    ...(allowed ? {} : { reason: clock === 'break' ? 'You are on a break in the HRMS.' : 'You are not checked in on the HRMS.' })
  })
})

route('GET', /^\/api\/tracker\/projects$/, async (req, res) => {
  send(res, 200, { projects })
})

route('PUT', /^\/api\/tracker\/sessions\/([^/]+)$/, async (req, res, u, [id]) => {
  const b = await readJson(req)
  if (!UUID.test(id) || b.id !== id) return send(res, 400, { error: 'Invalid session id' })
  if (!['ACTIVE', 'PAUSED', 'COMPLETED', 'INTERRUPTED'].includes(b.status)) return send(res, 400, { error: 'Invalid status' })
  if (!isIso(b.startedAt)) return send(res, 400, { error: 'Invalid startedAt' })
  const existing = sessions.get(id)
  if (existing && existing.employeeId !== u.id) return send(res, 403, { error: 'Not your session' })
  // A finished session can't be reopened by a late/out-of-order update.
  if (existing && ['COMPLETED', 'INTERRUPTED'].includes(existing.status) && ['ACTIVE', 'PAUSED'].includes(b.status)) {
    return send(res, 200, { ok: true })
  }
  sessions.set(id, {
    id,
    employeeId: u.id,
    startedAt: b.startedAt,
    endedAt: b.endedAt ?? null,
    status: b.status,
    lastActivityAt: b.lastActivityAt ?? null,
    pausedSeconds: Number(b.pausedSeconds) || 0,
    // Like the HRMS: fixed at first save, and only a known project.
    projectId: existing ? existing.projectId : projects.some((p) => p.id === b.projectId) ? b.projectId : null,
    lastSyncAt: new Date().toISOString()
  })
  send(res, 200, { ok: true })
})

route('POST', /^\/api\/tracker\/activity$/, async (req, res, u) => {
  const { logs } = await readJson(req)
  if (!Array.isArray(logs) || logs.length > 500) return send(res, 400, { error: 'logs must be an array (max 500)' })
  for (const l of logs) {
    const s = sessions.get(l.sessionId)
    if (!s) return send(res, 404, { error: `Unknown session ${l.sessionId}` })
    if (s.employeeId !== u.id) return send(res, 403, { error: 'Not your session' })
    if (!UUID.test(l.id) || !isIso(l.intervalStart) || !isIso(l.intervalEnd)) return send(res, 400, { error: 'Invalid log' })
    if (!['ACTIVE', 'INACTIVE', 'UNTRACKED'].includes(l.status)) return send(res, 400, { error: 'Invalid log status' })
  }
  let stored = 0
  for (const l of logs) {
    if (activity.has(l.id)) continue // idempotent
    activity.set(l.id, { ...l, mouseClickCount: l.mouseClickCount | 0, keyboardEventCount: l.keyboardEventCount | 0 })
    sessions.get(l.sessionId).lastSyncAt = new Date().toISOString()
    stored++
  }
  send(res, 200, { stored })
})

route('POST', /^\/api\/tracker\/screenshots$/, async (req, res, u) => {
  const b = await readJson(req, 6 * 1024 * 1024)
  const s = sessions.get(b.sessionId)
  if (!s) return send(res, 404, { error: 'Unknown session' })
  if (s.employeeId !== u.id) return send(res, 403, { error: 'Not your session' })
  if (!UUID.test(b.id) || !isIso(b.capturedAt)) return send(res, 400, { error: 'Invalid screenshot' })
  if (b.mimeType !== 'image/jpeg') return send(res, 415, { error: 'Only image/jpeg is accepted' })
  const image = Buffer.from(String(b.imageBase64 || ''), 'base64')
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) return send(res, 413, { error: 'Image empty or too large' })
  if (!(image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff)) return send(res, 415, { error: 'Not a JPEG' })
  if (!screenshots.has(b.id)) {
    screenshots.set(b.id, { meta: { id: b.id, sessionId: b.sessionId, capturedAt: b.capturedAt, employeeId: u.id }, image })
  }
  s.lastSyncAt = new Date().toISOString()
  send(res, 200, { ok: true })
})

route('GET', /^\/api\/tracker\/screenshots$/, async (req, res, u, _m, url) => {
  const [from, to] = dayRange(url.searchParams.get('date'), url.searchParams.get('tz'))
  const list = [...screenshots.values()]
    .map((x) => x.meta)
    .filter((m) => m.employeeId === u.id && Date.parse(m.capturedAt) >= from && Date.parse(m.capturedAt) < to)
    .map(({ id, sessionId, capturedAt }) => ({ id, sessionId, capturedAt }))
  send(res, 200, { screenshots: list })
})

route('GET', /^\/api\/tracker\/screenshots\/([^/]+)\/image$/, async (req, res, u, [id]) => {
  const s = screenshots.get(id)
  if (!s || s.meta.employeeId !== u.id) return send(res, 404, { error: 'Not found' })
  send(res, 200, s.image, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
})

route('GET', /^\/api\/tracker\/activity$/, async (req, res, u, _m, url) => {
  const [from, to] = dayRange(url.searchParams.get('date'), url.searchParams.get('tz'))
  const logs = [...activity.values()].filter((l) => {
    const t = Date.parse(l.intervalStart)
    return sessions.get(l.sessionId)?.employeeId === u.id && t >= from && t < to
  })
  send(res, 200, { logs })
})

route('POST', /^\/api\/tracker\/alerts$/, async (req, res, u) => {
  const b = await readJson(req)
  if (!alerts.some((a) => a.id === b.id)) alerts.push({ ...b, employeeId: u.id, receivedAt: new Date().toISOString() })
  console.log(`[alert] ${u.email}: ${b.type} — ${b.message}`)
  send(res, 200, { ok: true })
})

function adminPage() {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  const rows = [...sessions.values()]
    .map((s) => {
      const logs = [...activity.values()].filter((l) => l.sessionId === s.id)
      const shots = [...screenshots.values()].filter((x) => x.meta.sessionId === s.id).length
      return `<tr><td>${esc(s.employeeId)}</td><td><code>${esc(s.id.slice(0, 8))}</code></td><td>${esc(s.status)}</td><td>${esc(s.startedAt)}</td><td>${esc(s.endedAt)}</td><td>${s.pausedSeconds}s</td><td>${logs.length}</td><td>${shots}</td><td>${esc(s.lastSyncAt)}</td></tr>`
    })
    .join('')
  const alertRows = alerts.map((a) => `<li>${esc(a.receivedAt)} — ${esc(a.employeeId)} — <b>${esc(a.type)}</b>: ${esc(a.message)}</li>`).join('')
  const seen = [...lastSeen.entries()].map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>Mock HRMS</title>
  <style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>
  <h1>Mock HRMS tracker data</h1><h2>Sessions</h2><table><tr><th>Employee</th><th>Session</th><th>Status</th><th>Started</th><th>Ended</th><th>Paused</th><th>Activity logs</th><th>Screenshots</th><th>Last sync</th></tr>${rows}</table>
  <h2>Alerts</h2><ul>${alertRows || '<li>none</li>'}</ul><h2>Tracker last seen</h2><ul>${seen || '<li>none</li>'}</ul>`
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'POST' && url.pathname === '/admin/clock') {
      const value = url.searchParams.get('value')
      if (!['working', 'break', 'off'].includes(value)) return send(res, 400, { error: 'value must be working, break or off' })
      clockOverride = value
      return send(res, 200, { clock: value })
    }
    if (req.method === 'GET' && url.pathname === '/admin/link') {
      const u = users.find((x) => x.id === url.searchParams.get('user')) || users[0]
      const code = randomBytes(18).toString('base64url')
      linkCodes.set(code, { userId: u.id, expiresAt: Date.now() + 5 * 60_000 })
      const params = new URLSearchParams({ code, server: `http://localhost:${PORT}`, user: u.id })
      return send(res, 200, { link: `krishnatracker://start?${params}` })
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(adminPage())
    }
    if (req.method === 'GET' && url.pathname === '/admin/data.json') {
      return send(res, 200, {
        sessions: [...sessions.values()],
        activity: [...activity.values()],
        screenshots: [...screenshots.values()].map((x) => ({ ...x.meta, bytes: x.image.length })),
        alerts
      })
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.pattern)
      if (!m) continue
      const isPublic = ['/auth/login', '/auth/link', '/auth/logout'].some((p) => url.pathname.endsWith(p))
      const u = isPublic ? null : authUser(req)
      if (!isPublic && !u) return send(res, 401, { error: 'Unauthorized' })
      return await r.handler(req, res, u, m.slice(1).map(decodeURIComponent), url)
    }
    send(res, 404, { error: 'Not found' })
  } catch (e) {
    console.error(e)
    send(res, e.status || 500, { error: e.message })
  }
}).listen(PORT, () => {
  console.log(`Mock HRMS tracker API on http://localhost:${PORT}  (admin view: /admin)`)
})
