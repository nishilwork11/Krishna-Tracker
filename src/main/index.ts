/**
 * Main-process entry point: process-level setup and application lifecycle.
 *
 * Close vs. quit (plan §4.2):
 *   Window close  → hide to tray; tracking continues (notified once).
 *   Tray "Quit"   → confirm "Quitting will stop tracking", end session COMPLETED,
 *                   bounded final upload, exit.
 *   OS shutdown / logoff → end session INTERRUPTED immediately (data is already queued).
 *   Crash / kill  → detected on next launch; session closed INTERRUPTED (SessionTracker).
 *
 * The HRMS web app reaches the tracker through krishnatracker:// links (Check in, "Open
 * desktop app", "Open tracker"; see app/deep-link.ts). They open the app signed in and
 * ready; the employee starts the timer here. The first launch receives one on the command
 * line; a running app gets it via 'second-instance' (Windows/Linux) or 'open-url' (macOS).
 *
 * Layout of src/main:
 *   app/       Electron UI shell: window, tray, IPC, icons
 *   core/      domain logic: session state machine, input counting, screenshots, sync
 *   data/      local SQLite: migrations, outbox queue, key/value state
 *   platform/  infrastructure: config, logging, secure storage, HTTP client, paths
 *   dev/       development-only self-tests (never active in packaged builds)
 */
import { app, BrowserWindow, dialog, powerMonitor } from 'electron'
import { resolve } from 'path'
import { DEEP_LINK_SCHEME, deepLinkFromArgv, parseDeepLink, type DeepLink } from './app/deep-link'
import { registerIpcHandlers } from './app/ipc-handlers'
import { createMainWindow } from './app/main-window'
import { TrayController } from './app/tray'
import { IpcChannel } from '@shared/ipc'
import { TrackerService } from './core/tracker-service'
import { closeDb, getDb } from './data/database'
import { closeLogger, createLogger } from './platform/logger'

const log = createLogger('main')

// ------------------------------------------------------------------ process setup

// Dev/test only: isolate the data folder (lets several profiles or tests run side by side).
if (!app.isPackaged && process.env.TRACKER_USER_DATA) app.setPath('userData', process.env.TRACKER_USER_DATA)

// One instance per user: two trackers would double-count and fight over the database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.setAppUserModelId('com.hrms.desktoptracker') // required for Windows notifications

// Claim krishnatracker:// so "Start timer" in the HRMS opens this app. The installer
// registers it too; doing it here keeps it right after a move, and makes it work in dev
// (where the OS must be told to start Electron with this app's folder).
if (process.env.TRACKER_SELFTEST !== '1') {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])])
  } else if (!process.defaultApp) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  }
}

process.on('uncaughtException', (e) => log.error('Uncaught exception', e))
process.on('unhandledRejection', (e) => log.error('Unhandled rejection', e))

// ------------------------------------------------------------------ app state

let service: TrackerService
let tray: TrayController | null = null
let win: BrowserWindow | null = null
/** True once we have decided to exit; lets window close / before-quit proceed. */
let quitting = false
let toldAboutTray = false
/** A link that arrived before the service was ready; handled once it is. */
let pendingLink: DeepLink | null = deepLinkFromArgv(process.argv)
let ready = false

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    win = createMainWindow({ show: true, onCloseRequested: () => quitting, onSessionEnd: handleOsShutdown })
    attachWindowEvents(win)
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function attachWindowEvents(w: BrowserWindow): void {
  w.on('hide', () => {
    if (!toldAboutTray && service.session.current && !quitting) {
      toldAboutTray = true
      service.notify('Still tracking', 'The tracker keeps running in the system tray. Use Quit from the tray menu to stop.')
    }
  })
}

/** A krishnatracker:// link from the HRMS: bring the window up, then act on it. */
function handleDeepLink(link: DeepLink): void {
  if (!ready) {
    pendingLink = link
    return
  }
  showWindow()
  if (link.action === 'start') void service.openFromLink(link, confirmServer)
}

/** Asked before a link may point the tracker at a server it has not been using. */
async function confirmServer(url: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Connect', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Connect to HRMS',
    message: `Connect the tracker to ${new URL(url).host}?`,
    detail:
      'A link asked this app to sign in to a server it has not used before. Continue only if you just pressed Start timer in your company HRMS at this address.'
  })
  return response === 0
}

/** User-initiated quit (tray menu, or Cmd+Q / taskbar "Close window" routed via before-quit). */
async function confirmAndQuit(): Promise<void> {
  if (quitting) return
  if (service.session.current) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Stop tracking and quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Quit HRMS Tracker',
      message: 'Quitting will stop tracking.',
      detail:
        'Your current work session will end now. To keep tracking in the background, close the window instead — the tracker stays in the system tray.'
    })
    if (response !== 0) return
  }
  quitting = true
  log.info('Quitting (user)')
  await service.shutdown('COMPLETED', true)
  app.quit()
}

/** OS shutdown/logoff: no time for dialogs or network; persist and let the OS proceed. */
function handleOsShutdown(): void {
  if (quitting) return
  quitting = true
  log.info('OS shutdown/logoff')
  void service.shutdown('INTERRUPTED', false)
}

// ------------------------------------------------------------------ lifecycle

app.on('second-instance', (_event, argv) => {
  const link = deepLinkFromArgv(argv)
  if (link) handleDeepLink(link)
  else showWindow()
})

// macOS delivers links here, possibly before 'ready' — so it is registered at top level.
app.on('open-url', (event, url) => {
  event.preventDefault()
  const link = parseDeepLink(url)
  if (link) handleDeepLink(link)
})

app.whenReady().then(async () => {
  log.info(`Starting v${app.getVersion()} (${process.platform}, packaged=${app.isPackaged})`)
  getDb()

  service = new TrackerService()
  registerIpcHandlers(service)
  tray = new TrayController(service, { showWindow, quit: () => void confirmAndQuit() })

  service.onState((s) => {
    if (win && !win.isDestroyed()) win.webContents.send(IpcChannel.StateChanged, s)
    tray?.update(s)
  })
  service.init()
  tray.update(service.getState())

  powerMonitor.on('suspend', () => service.onSuspend())
  powerMonitor.on('resume', () => service.onResume())
  powerMonitor.on('lock-screen', () => service.setScreenLocked(true))
  powerMonitor.on('unlock-screen', () => service.setScreenLocked(false))
  powerMonitor.on('shutdown', handleOsShutdown) // macOS/Linux; Windows uses window 'session-end'

  // Development-only automated checks (see dev/selftest.ts). Never available when packaged.
  if (!app.isPackaged && process.env.TRACKER_SELFTEST === '1') {
    quitting = true
    const { runSelfTest } = await import('./dev/selftest')
    const needsWindow = process.env.SELFTEST_MODE === 'ui'
    if (needsWindow) win = createMainWindow({ show: true, onCloseRequested: () => true, onSessionEnd: () => {} })
    await runSelfTest(service, win)
    return
  }

  // Started at OS login with --hidden: live in the tray without popping a window.
  win = createMainWindow({
    show: !process.argv.includes('--hidden') || pendingLink !== null,
    onCloseRequested: () => quitting,
    onSessionEnd: handleOsShutdown
  })
  attachWindowEvents(win)

  ready = true
  if (pendingLink) {
    const link = pendingLink
    pendingLink = null
    handleDeepLink(link)
  }
})

// Keep running in the tray when the window is closed.
app.on('window-all-closed', () => {
  /* intentionally empty: the tray keeps the app alive */
})

app.on('before-quit', (e) => {
  if (quitting) return
  // A quit we did not initiate (e.g. macOS Cmd+Q): route through the confirmation flow.
  e.preventDefault()
  void confirmAndQuit()
})

app.on('will-quit', () => {
  tray?.destroy()
  closeDb()
  log.info('Exited')
  closeLogger()
})
