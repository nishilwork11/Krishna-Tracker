import { DatabaseSync } from 'node:sqlite'
import { existsSync, renameSync } from 'fs'
import { createLogger } from '../platform/logger'
import { paths } from '../platform/paths'

/**
 * Local SQLite database (Electron's built-in `node:sqlite`, so no native build step).
 *
 * Holds only the upload queue and a little app state. It is NOT a copy of HRMS data:
 * rows are deleted once the server confirms them.
 *
 * Schema changes go through MIGRATIONS below, tracked with `PRAGMA user_version`.
 * Never edit a released migration; append a new one.
 */

const log = createLogger('db')

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id              TEXT PRIMARY KEY,           -- record UUID (also the server idempotency key)
    employee_id     TEXT NOT NULL,              -- owner; only uploaded with that employee's token
    kind            TEXT NOT NULL,              -- 'session' | 'activity' | 'screenshot' | 'alert'
    session_id      TEXT,
    payload         TEXT NOT NULL,              -- JSON body (screenshot bytes live in file_path)
    file_path       TEXT,                       -- encrypted screenshot file, if any
    bytes           INTEGER NOT NULL DEFAULT 0, -- size on disk, for the storage cap
    version         INTEGER NOT NULL DEFAULT 1, -- bumped when a session row is replaced
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0, -- epoch ms; backoff gate
    created_at      INTEGER NOT NULL,
    last_error      TEXT
  );
  CREATE INDEX IF NOT EXISTS outbox_by_kind ON outbox (employee_id, kind, next_attempt_at);
  `
]

let db: DatabaseSync | null = null

function openAndCheck(file: string): DatabaseSync {
  const conn = new DatabaseSync(file)
  // WAL survives crashes/power loss without corrupting committed data; NORMAL sync is
  // safe in WAL mode and much faster. busy_timeout guards against transient locks.
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  const check = conn.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined
  if (check?.quick_check !== 'ok') {
    conn.close()
    throw new Error(`quick_check failed: ${check?.quick_check}`)
  }
  return conn
}

function migrate(conn: DatabaseSync): void {
  const { user_version: current } = conn.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < MIGRATIONS.length; v++) {
    log.info(`Applying migration v${v + 1}`)
    conn.exec('BEGIN')
    try {
      conn.exec(MIGRATIONS[v])
      conn.exec(`PRAGMA user_version = ${v + 1}`)
      conn.exec('COMMIT')
    } catch (e) {
      conn.exec('ROLLBACK')
      throw e
    }
  }
}

/** Opens (once) and returns the database. Recovers from a corrupt file by starting fresh. */
export function getDb(): DatabaseSync {
  if (db) return db
  const file = paths.database()
  try {
    db = openAndCheck(file)
  } catch (e) {
    // A corrupt queue must not brick the app. Keep the bad file for support, start clean.
    const backup = `${file}.corrupt-${Date.now()}`
    log.error(`Database unusable, moving it to ${backup}`, e)
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) renameSync(file + suffix, backup + suffix)
    }
    db = openAndCheck(file)
  }
  migrate(db)
  return db
}

export function closeDb(): void {
  try {
    db?.close()
  } catch (e) {
    log.warn('Error closing database', e)
  }
  db = null
}
