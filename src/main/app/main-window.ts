import { BrowserWindow, session, shell } from 'electron'
import { join } from 'path'
import { appIcon } from './icons'

/**
 * The single application window, hardened per Electron's security checklist:
 *  - contextIsolation + sandbox, no nodeIntegration: the renderer only gets `window.tracker`.
 *  - Navigation away from the app is blocked; external links open in the system browser.
 *  - All web permission requests (camera, notifications, …) are denied: the renderer needs none.
 */

/** URL the renderer is served from. Used to validate IPC senders and block navigation. */
export function rendererOrigin(): string {
  return process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : 'file://'
}

export function isAppUrl(url: string): boolean {
  return rendererOrigin() === 'file://' ? url.startsWith('file://') : url.startsWith(rendererOrigin())
}

let securityApplied = false

function applySessionSecurity(): void {
  if (securityApplied) return
  securityApplied = true
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

export interface MainWindowOptions {
  show: boolean
  /** Called when the user closes the window; return true to allow it to actually close. */
  onCloseRequested: () => boolean
  /** Windows logoff/shutdown. */
  onSessionEnd: () => void
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  applySessionSecurity()

  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'HRMS Desktop Tracker',
    icon: appIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => {
    if (opts.show) win.show()
  })

  win.on('close', (e) => {
    if (!opts.onCloseRequested()) {
      e.preventDefault()
      win.hide()
    }
  })

  // Windows logoff/shutdown. 'query-session-end' can arrive first; handling both guarantees
  // we mark quitting before any quit-confirmation dialog could block the OS shutdown.
  win.on('query-session-end', opts.onSessionEnd)
  win.on('session-end', opts.onSessionEnd)

  // Block in-app navigation to anything that isn't the app itself.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
