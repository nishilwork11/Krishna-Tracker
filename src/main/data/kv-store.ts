import { getDb } from './database'

/**
 * Tiny persistent key/value store for app state that must survive restarts
 * (the live session, last sync time, alert cooldowns).
 * Values are JSON-encoded; a value that fails to parse is treated as absent.
 */

export const KvKey = {
  Session: 'session',
  LastSyncAt: 'lastSyncAt',
  AlertCooldown: (type: string) => `lastAlert:${type}`
} as const

export function kvGet<T>(key: string): T | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as T
  } catch {
    return null
  }
}

export function kvSet(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export function kvDelete(key: string): void {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(key)
}
