import { BrowserWindow, screen } from 'electron'
import { createLogger } from '../platform/logger'

/**
 * The "Are you still working?" card: a small always-on-top window the app draws itself, so it
 * does not depend on the OS allowing notifications (Focus Assist, Do Not Disturb, settings).
 *
 * No preload and no Node access: the button sets the page title to a marker, which the main
 * process sees as `page-title-updated`. The page only shows text and a countdown.
 * Any navigation is blocked, so nothing can load into the card.
 */

const log = createLogger('idle-prompt')

const CONFIRM_TITLE = 'idle:confirm'
const WIDTH = 340
const HEIGHT = 170
const MARGIN = 16

export interface IdlePrompt {
  /** True once the card has loaded, i.e. it is really on screen. */
  readonly shown: boolean
  close(): void
}

export interface IdlePromptOptions {
  /** Epoch ms at which the timer pauses; drives the countdown. */
  deadline: number
  /** How long there has been no input, already worded ("5 minutes"). */
  quiet: string
  onConfirm(): void
}

export function showIdlePrompt(opts: IdlePromptOptions): IdlePrompt {
  const state = { shown: false }
  let win: BrowserWindow | null = null

  try {
    // The screen the cursor is on is where the employee was last working.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: workArea.x + workArea.width - WIDTH - MARGIN,
      y: workArea.y + workArea.height - HEIGHT - MARGIN,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false, // never steals the keyboard, so a stray keystroke cannot dismiss it
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const w = win
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.on('page-title-updated', (e, title) => {
      e.preventDefault()
      if (title === CONFIRM_TITLE) opts.onConfirm()
    })
    w.webContents.on('did-fail-load', () => {
      state.shown = false
      log.warn('Idle card failed to load')
    })
    w.webContents.on('did-finish-load', () => {
      if (w.isDestroyed()) return
      w.showInactive()
      state.shown = true
    })
    void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(opts)))
  } catch (e) {
    log.warn('Idle card could not be created', e)
  }

  return {
    get shown() {
      return state.shown && !!win && !win.isDestroyed() && win.isVisible()
    },
    close() {
      state.shown = false
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page({ deadline, quiet }: IdlePromptOptions): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; overflow:hidden; font:14px 'Segoe UI',system-ui,sans-serif; }
  body { box-sizing:border-box; padding:16px 18px; border:1px solid #8885;
         background:Canvas; color:CanvasText; display:flex; flex-direction:column; gap:8px; }
  h1 { margin:0; font-size:16px; }
  p { margin:0; opacity:.8; line-height:1.4; }
  #t { font-variant-numeric:tabular-nums; font-weight:600; opacity:1; }
  button { margin-top:auto; padding:9px 12px; border:0; border-radius:8px; cursor:pointer;
      background:#2563eb; color:#fff; font:600 14px 'Segoe UI',system-ui,sans-serif; }
  button:hover { background:#1d4ed8; }
</style></head><body>
<h1>Are you still working?</h1>
<p>No activity for ${esc(quiet)}. Your timer pauses in <span id="t"></span>.</p>
<button id="ok">Yes, I'm still working</button>
<script>
  var end = ${Math.floor(deadline)};
  function tick() {
    var s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    document.getElementById('t').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  tick(); setInterval(tick, 500);
  document.getElementById('ok').onclick = function () { document.title = '${CONFIRM_TITLE}'; };
</script></body></html>`
}
