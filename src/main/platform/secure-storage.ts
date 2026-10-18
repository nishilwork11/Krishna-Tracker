import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import type { UserInfo } from '@shared/api-contract'
import { createLogger } from './logger'
import { paths } from './paths'

/**
 * Protection for data at rest on the employee's computer.
 *
 * - Small secrets (auth token, file key) are encrypted with the OS credential store
 *   via Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 * - Pending screenshot files are encrypted with AES-256-GCM using a random per-install key
 *   that is itself stored via safeStorage. A copied file is useless without the user's
 *   OS login, and GCM's auth tag detects tampering/corruption.
 */

const log = createLogger('secure')
const PLAIN_MARKER = 'plain:'

function writeAtomic(file: string, data: Buffer | string): void {
  writeFileSync(`${file}.tmp`, data)
  renameSync(`${file}.tmp`, file)
}

function writeSecret(file: string, value: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    writeAtomic(file, safeStorage.encryptString(value))
  } else {
    // Only happens on Linux without a keyring. Logged so support can spot it.
    log.warn('OS encryption unavailable; storing secret obfuscated only')
    writeAtomic(file, PLAIN_MARKER + Buffer.from(value).toString('base64'))
  }
}

function readSecret(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file)
    if (raw.subarray(0, PLAIN_MARKER.length).toString() === PLAIN_MARKER) {
      return Buffer.from(raw.subarray(PLAIN_MARKER.length).toString(), 'base64').toString()
    }
    return safeStorage.decryptString(raw)
  } catch (e) {
    // e.g. the Windows profile was reset, so DPAPI can no longer decrypt.
    log.warn(`Could not decrypt ${file}`, e)
    return null
  }
}

// ---------------------------------------------------------------- auth token

export interface StoredAuth {
  token: string
  expiresAt: string
  apiBaseUrl: string
  user: UserInfo
}

export function saveAuth(auth: StoredAuth): void {
  writeSecret(paths.authFile(), JSON.stringify(auth))
}

/** Returns the stored sign-in, or null if absent, unreadable or expired. */
export function loadAuth(): StoredAuth | null {
  const raw = readSecret(paths.authFile())
  if (!raw) return null
  try {
    const auth = JSON.parse(raw) as StoredAuth
    if (!auth.token || !auth.user?.id || new Date(auth.expiresAt).getTime() <= Date.now()) return null
    return auth
  } catch {
    return null
  }
}

export function clearAuth(): void {
  const file = paths.authFile()
  if (existsSync(file)) unlinkSync(file)
}

// ---------------------------------------------------------------- file encryption

let fileKey: Buffer | null = null

function getFileKey(): Buffer {
  if (fileKey) return fileKey
  const existing = readSecret(paths.fileKey())
  if (existing) {
    fileKey = Buffer.from(existing, 'base64')
  } else {
    // First run, or the old key is unreadable. Any files encrypted with the old key
    // become undecryptable and will be discarded by the uploader (logged there).
    if (existsSync(paths.fileKey())) log.warn('File key unreadable; generating a new one')
    fileKey = randomBytes(32)
    writeSecret(paths.fileKey(), fileKey.toString('base64'))
  }
  return fileKey
}

const IV_BYTES = 12
const TAG_BYTES = 16

/** Output layout: IV (12) | auth tag (16) | ciphertext. */
export function encryptBuffer(data: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getFileKey(), iv)
  const enc = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

/** Throws if the blob was corrupted, truncated or encrypted with another key. */
export function decryptBuffer(blob: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted blob too short')
  const iv = blob.subarray(0, IV_BYTES)
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', getFileKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
}
