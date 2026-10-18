import { getDb } from './database'

/**
 * The outbox: a persistent queue of records waiting to be uploaded.
 *
 * Lifecycle of a row:
 *   enqueue() → [uploader picks it via dueItems()] → server 2xx → remove()
 *                                                  → failure     → markFailed() (backoff)
 *
 * Rows are only ever deleted after the server confirms storage, so nothing captured
 * is lost to crashes, restarts or network failures.
 */

export type OutboxKind = 'session' | 'activity' | 'screenshot' | 'alert'

export interface OutboxRow {
  id: string
  employee_id: string
  kind: OutboxKind
  session_id: string | null
  payload: string
  file_path: string | null
  bytes: number
  version: number
  attempts: number
  next_attempt_at: number
  created_at: number
  last_error: string | null
}

export interface NewOutboxItem {
  id: string
  employeeId: string
  kind: OutboxKind
  sessionId: string | null
  payload: unknown
  filePath?: string | null
  bytes?: number
}

/** Transient failures (offline server, 5xx): 5 s, 10 s, 20 s … capped at 5 min. */
const TRANSIENT_BASE_MS = 5_000
const TRANSIENT_MAX_MS = 5 * 60_000
/** Permanent failures (4xx): the server rejected the record. Retry rarely (1 min … 1 h) so
 *  one bad record never blocks the queue, yet is kept in case a server fix accepts it. */
const PERMANENT_BASE_MS = 60_000
const PERMANENT_MAX_MS = 60 * 60_000

export function enqueue(item: NewOutboxItem): void {
  getDb()
    .prepare(
      `INSERT INTO outbox (id, employee_id, kind, session_id, payload, file_path, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.employeeId,
      item.kind,
      item.sessionId,
      JSON.stringify(item.payload),
      item.filePath ?? null,
      item.bytes ?? 0,
      Date.now()
    )
}

/**
 * Sessions are "latest state wins": one row per session, replaced on every change.
 * `version` lets the uploader delete exactly the state it sent, so an update made while
 * that upload was in flight is not lost.
 */
export function upsertSession(employeeId: string, sessionId: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO outbox (id, employee_id, kind, session_id, payload, created_at)
       VALUES (?, ?, 'session', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload, version = version + 1,
         attempts = 0, next_attempt_at = 0, last_error = NULL`
    )
    .run(`session:${sessionId}`, employeeId, sessionId, JSON.stringify(payload), Date.now())
}

/** Rows of one kind that are not in backoff, oldest first. */
export function dueItems(employeeId: string, kind: OutboxKind, limit: number): OutboxRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM outbox
       WHERE employee_id = ? AND kind = ? AND next_attempt_at <= ?
       ORDER BY created_at, id LIMIT ?`
    )
    .all(employeeId, kind, Date.now(), limit) as unknown as OutboxRow[]
}

export function getItem(id: string): OutboxRow | null {
  return (getDb().prepare('SELECT * FROM outbox WHERE id = ?').get(id) as unknown as OutboxRow | undefined) ?? null
}

/** Deletes a row. With `version`, only if it was not replaced since it was read. */
export function remove(id: string, version?: number): boolean {
  const stmt =
    version === undefined
      ? getDb().prepare('DELETE FROM outbox WHERE id = ?')
      : getDb().prepare('DELETE FROM outbox WHERE id = ? AND version = ?')
  const res = version === undefined ? stmt.run(id) : stmt.run(id, version)
  return Number(res.changes) > 0
}

export function markFailed(id: string, error: string, retryable: boolean): void {
  const row = getItem(id)
  if (!row) return
  const attempts = row.attempts + 1
  const [base, max] = retryable ? [TRANSIENT_BASE_MS, TRANSIENT_MAX_MS] : [PERMANENT_BASE_MS, PERMANENT_MAX_MS]
  const delay = Math.min(base * 2 ** Math.min(attempts - 1, 20), max)
  getDb()
    .prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
    .run(attempts, Date.now() + delay, error.slice(0, 500), id)
}

/** Restores a row's retry bookkeeping to an earlier snapshot (undoes a markFailed). */
export function restoreAttempts(row: Pick<OutboxRow, 'id' | 'attempts' | 'next_attempt_at' | 'last_error'>): void {
  getDb()
    .prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
    .run(row.attempts, row.next_attempt_at, row.last_error, row.id)
}

/** Makes all of an employee's rows eligible immediately ("Sync now", back online, wake). */
export function resetBackoff(employeeId: string): void {
  getDb().prepare('UPDATE outbox SET next_attempt_at = 0 WHERE employee_id = ?').run(employeeId)
}

/** Count and bytes waiting; for one employee, or for everyone when `employeeId` is null. */
export function pendingStats(employeeId: string | null): { count: number; bytes: number } {
  const row = (
    employeeId === null
      ? getDb().prepare('SELECT COUNT(*) AS c, COALESCE(SUM(bytes), 0) AS b FROM outbox').get()
      : getDb()
          .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(bytes), 0) AS b FROM outbox WHERE employee_id = ?')
          .get(employeeId)
  ) as { c: number; b: number }
  return { count: Number(row.c), bytes: Number(row.b) }
}

export function allOfKind(employeeId: string, kind: OutboxKind): OutboxRow[] {
  return getDb()
    .prepare('SELECT * FROM outbox WHERE employee_id = ? AND kind = ? ORDER BY created_at')
    .all(employeeId, kind) as unknown as OutboxRow[]
}

/** Every screenshot file referenced by the queue (used to clean up orphaned files). */
export function referencedFiles(): Set<string> {
  const rows = getDb()
    .prepare("SELECT file_path FROM outbox WHERE kind = 'screenshot' AND file_path IS NOT NULL")
    .all() as Array<{ file_path: string }>
  return new Set(rows.map((r) => r.file_path))
}
