import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { TrackerService } from '../core/tracker-service'
import { createLogger } from '../platform/logger'
import { isAppUrl } from './main-window'

/**
 * IPC endpoints for the renderer.
 *
 * Defence in depth: even though the renderer is our own code, every handler
 *  1. rejects calls from any frame that is not the app's own page, and
 *  2. validates argument types and lengths before use.
 */

const log = createLogger('ipc')

class IpcValidationError extends Error {}

function str(v: unknown, name: string, max = 500): string {
  if (typeof v !== 'string' || v.length > max) throw new IpcValidationError(`Invalid ${name}`)
  return v
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new IpcValidationError(`Invalid ${name}`)
  return v
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const url = event.senderFrame?.url ?? ''
    if (!isAppUrl(url)) {
      log.warn(`Rejected IPC ${channel} from untrusted frame ${url}`)
      throw new Error('Untrusted sender')
    }
    try {
      return fn(...args)
    } catch (e) {
      if (e instanceof IpcValidationError) log.warn(`IPC ${channel}: ${e.message}`)
      throw e
    }
  })
}

export function registerIpcHandlers(service: TrackerService): void {
  handle(IpcChannel.GetState, () => service.getState())
  handle(IpcChannel.Login, (url, email, password) =>
    service.login(str(url, 'server URL', 300), str(email, 'email', 320), str(password, 'password', 1000))
  )
  handle(IpcChannel.Logout, () => service.logout())
  handle(IpcChannel.Start, (projectId) => {
    if (projectId !== null && projectId !== undefined) str(projectId, 'project', 64)
    return service.start((projectId as string | null | undefined) ?? null)
  })
  handle(IpcChannel.Pause, () => service.pause())
  handle(IpcChannel.Resume, () => service.resume())
  handle(IpcChannel.Stop, () => service.stop())
  handle(IpcChannel.SyncNow, () => service.sync.syncNow())
  handle(IpcChannel.GetActivity, (date) => {
    const d = str(date, 'date', 10)
    if (!DATE.test(d)) throw new IpcValidationError('Invalid date')
    return service.getActivity(d)
  })
  handle(IpcChannel.GetScreenshotImage, (id, pending) => {
    const s = str(id, 'id', 36)
    if (!UUID.test(s)) throw new IpcValidationError('Invalid id')
    return service.getScreenshotImage(s, bool(pending, 'pending'))
  })
  handle(IpcChannel.SetLaunchAtStartup, (enabled) => service.setLaunchAtStartup(bool(enabled, 'enabled')))
  handle(IpcChannel.DismissNotice, () => service.dismissNotice())
}
