import { app } from 'electron'
import { createWriteStream, existsSync, renameSync, statSync, unlinkSync, WriteStream } from 'fs'
import { join } from 'path'
import { paths } from './paths'

/**
 * Minimal file logger for the main process.
 *
 * - Writes to <userData>/logs/main.log, rotating to main.old.log at 5 MB, so support
 *   can ask an employee for the log file without it growing unbounded.
 * - Mirrors to the console in development.
 * - NEVER pass passwords, tokens or screenshot data to the logger.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024

let stream: WriteStream | null = null
let written = 0

function logFile(): string {
  return join(paths.logs(), 'main.log')
}

function rotate(): void {
  stream?.end()
  stream = null
  const file = logFile()
  const old = join(paths.logs(), 'main.old.log')
  try {
    if (existsSync(old)) unlinkSync(old)
    if (existsSync(file)) renameSync(file, old)
  } catch {
    /* rotation is best effort; keep appending to the current file */
  }
  written = 0
}

function open(): WriteStream {
  if (stream) return stream
  const file = logFile()
  if (existsSync(file)) {
    written = statSync(file).size
    if (written > MAX_BYTES) rotate()
  }
  stream = createWriteStream(file, { flags: 'a' })
  // A logging failure must never take the app down.
  stream.on('error', () => {
    stream = null
  })
  return stream
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: Level, scope: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(format).join(' ')}\n`
  if (!app.isPackaged || level === 'error') {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(line.trimEnd())
  }
  try {
    const s = open()
    s.write(line)
    written += Buffer.byteLength(line)
    if (written > MAX_BYTES) rotate()
  } catch {
    /* ignore — see above */
  }
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Returns a logger that prefixes every line with `[scope]`. */
export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => {
      if (!app.isPackaged) write('debug', scope, a)
    },
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a)
  }
}

export function closeLogger(): void {
  stream?.end()
  stream = null
}
