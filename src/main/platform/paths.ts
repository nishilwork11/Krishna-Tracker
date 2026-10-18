import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

/**
 * All on-disk state lives under Electron's per-user data folder
 * (Windows: %APPDATA%\<productName>). Nothing is written next to the executable,
 * which is read-only for standard users after installation.
 */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export const paths = {
  dataDir: (): string => ensureDir(app.getPath('userData')),
  configFile: (): string => join(paths.dataDir(), 'config.json'),
  database: (): string => join(paths.dataDir(), 'tracker.db'),
  authFile: (): string => join(paths.dataDir(), 'auth.bin'),
  fileKey: (): string => join(paths.dataDir(), 'filekey.bin'),
  pendingScreenshots: (): string => ensureDir(join(paths.dataDir(), 'pending-screenshots')),
  logs: (): string => ensureDir(join(paths.dataDir(), 'logs'))
}
