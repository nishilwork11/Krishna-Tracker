import { Menu, Tray } from 'electron'
import type { TrackerState } from '@shared/ipc'
import type { TrackerService } from '../core/tracker-service'
import { IconTone, trayIcon } from './icons'

/**
 * System-tray icon and menu. The tray is how the app stays reachable (and visibly
 * tracking) after the window is closed.
 */

export interface TrayActions {
  showWindow(): void
  quit(): void
}

function toneFor(s: TrackerState): IconTone {
  // A session still running while signed out (token expired) needs attention too.
  if (s.status === 'permission-issue' || (s.sessionStatus && s.status === 'signed-out')) return 'problem'
  if (s.sessionStatus === 'ACTIVE') return 'active'
  if (s.sessionStatus === 'PAUSED') return 'paused'
  return 'idle'
}

export class TrayController {
  private readonly tray: Tray
  private lastKey = ''

  constructor(
    private readonly service: TrackerService,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(trayIcon('idle'))
    this.tray.on('click', () => actions.showWindow())
  }

  /** Re-renders only when something visible in the tray changed (state is pushed often). */
  update(s: TrackerState): void {
    const key = [s.status, s.sessionStatus, s.online, s.syncing, s.pendingCount, s.trackingAllowed].join('|')
    if (key === this.lastKey) return
    this.lastKey = key

    const what = s.sessionStatus === 'ACTIVE' ? 'Tracking active' : s.sessionStatus === 'PAUSED' ? 'Tracking paused' : 'Not tracking'
    const conn = !s.online ? 'offline' : s.syncing ? 'syncing' : 'online'
    const signedIn = s.status !== 'signed-out'

    this.tray.setImage(trayIcon(toneFor(s)))
    this.tray.setToolTip(`HRMS Tracker — ${what} (${conn}, ${s.pendingCount} pending)`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: what, enabled: false },
        { type: 'separator' },
        { label: 'Open tracker', click: () => this.actions.showWindow() },
        {
          label: 'Start tracking',
          visible: signedIn && !s.sessionStatus,
          enabled: s.trackingAllowed,
          click: () => void this.service.start()
        },
        { label: 'Pause', visible: s.sessionStatus === 'ACTIVE', click: () => this.service.pause() },
        { label: 'Resume', visible: s.sessionStatus === 'PAUSED', click: () => this.service.resume() },
        { label: 'Stop tracking', visible: !!s.sessionStatus, click: () => this.service.stop() },
        { label: 'Sync now', enabled: signedIn, click: () => void this.service.sync.syncNow() },
        { type: 'separator' },
        { label: 'Quit', click: () => this.actions.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}
