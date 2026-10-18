import { useState } from 'react'
import type { HrmsClock } from '@shared/api-contract'
import type { ActionResult, TrackerDisplayStatus, TrackerState } from '@shared/ipc'
import { useElapsed } from '../hooks/useElapsed'
import { formatBytes, formatDuration, formatRelative, formatTime } from '../lib/format'
import Icon from './Icon'

const STATUS_LABEL: Record<TrackerDisplayStatus, string> = {
  'signed-out': 'Signed out',
  idle: 'Not tracking',
  active: 'Tracking',
  paused: 'Paused',
  'permission-issue': 'Needs attention'
}

/** The HRMS clock, in the words the web app uses for it. */
const CLOCK_LABEL: Record<HrmsClock, string> = {
  working: 'Checked in on the HRMS',
  break: 'On a break in the HRMS',
  off: 'Not checked in on the HRMS'
}

type Tone = 'active' | 'paused' | 'idle'
const toneOf = (s: TrackerState): Tone => (s.sessionStatus === 'ACTIVE' ? 'active' : s.sessionStatus === 'PAUSED' ? 'paused' : 'idle')

/** Main tab: timer + controls, sync status, permissions and settings. */
export default function TrackerPanel({ state }: { state: TrackerState }): React.JSX.Element {
  const elapsed = useElapsed(state)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // '' = no project. A project that left the list (archived meanwhile) falls back to none.
  const [projectId, setProjectId] = useState('')
  const pickedProject = state.projects.some((p) => p.id === projectId) ? projectId : ''
  const sessionProject = state.projects.find((p) => p.id === state.sessionProjectId) ?? null

  /** Runs an action with a busy flag; surfaces `{ ok:false }` results and thrown errors. */
  const run = async (action: () => Promise<ActionResult | void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await action()
      if (res && !res.ok) setError(res.error ?? 'Something went wrong')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = (): void => {
    const message = state.sessionStatus
      ? 'Signing out will stop your current tracking session. Continue?'
      : state.pendingCount > 0
        ? `${state.pendingCount} item(s) are still waiting to upload. They stay on this computer and upload the next time you sign in. Sign out?`
        : null
    if (message && !window.confirm(message)) return
    void run(() => window.tracker.logout())
  }

  const storagePct = state.storageLimitBytes > 0 ? Math.min(100, (state.pendingBytes / state.storageLimitBytes) * 100) : 0
  const conn = !state.online ? 'offline' : state.syncing ? 'syncing' : 'online'
  const tone = toneOf(state)

  return (
    <div className="layout">
      <section className={`hero tone-${tone}`}>
        <div className="hero-head">
          <span className={`pill pill-${state.status}`}>
            {state.sessionStatus === 'ACTIVE' && <span className="pulse" aria-hidden />}
            {STATUS_LABEL[state.status]}
          </span>
          <div className="hero-pills">
            {state.hrmsClock && (
              <span className={`pill clock-${state.hrmsClock}`}>
                <Icon name={state.hrmsClock === 'break' ? 'coffee' : 'clock'} size={13} />
                {CLOCK_LABEL[state.hrmsClock]}
              </span>
            )}
            <span className={`pill conn-${conn}`}>
              <Icon name={conn === 'offline' ? 'cloudOff' : 'cloud'} size={13} />
              {conn === 'online' ? 'Connected' : conn === 'syncing' ? 'Syncing…' : 'Offline'}
            </span>
          </div>
        </div>

        <div className="timer" aria-live="off">
          {formatDuration(elapsed)}
        </div>
        <div className="hero-sub">
          {state.startedAt ? `Started ${formatTime(state.startedAt)}` : 'Ready when you are'}
          {sessionProject && (
            <span className="project-chip">
              <Icon name="folder" size={12} />
              {sessionProject.name}
            </span>
          )}
        </div>

        {!state.sessionStatus && state.projects.length > 0 && (
          <label className="project-pick">
            <span className="field-label">
              Project <span className="subtle">— optional</span>
            </span>
            <select value={pickedProject} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
              <option value="">No project</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key} · {p.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="controls">
          {!state.sessionStatus && (
            <button
              className="btn primary big"
              disabled={busy || !state.trackingAllowed}
              onClick={() => void run(() => window.tracker.start(pickedProject || null))}
            >
              <Icon name="play" />
              Start tracking
            </button>
          )}
          {state.sessionStatus === 'ACTIVE' && (
            <button className="btn big" disabled={busy} onClick={() => void run(() => window.tracker.pause())}>
              <Icon name="pause" />
              Pause
            </button>
          )}
          {state.sessionStatus === 'PAUSED' && (
            <button className="btn primary big" disabled={busy} onClick={() => void run(() => window.tracker.resume())}>
              <Icon name="play" />
              Resume
            </button>
          )}
          {state.sessionStatus && (
            <button className="btn danger big" disabled={busy} onClick={() => void run(() => window.tracker.stop())}>
              <Icon name="stop" />
              Stop
            </button>
          )}
        </div>

        {error && (
          <div className="error center" role="alert">
            {error}
          </div>
        )}
        {!state.trackingAllowed && (
          <div className="callout">
            <Icon name="alert" />
            <span>{state.trackingBlockedReason ?? 'Tracking is not permitted right now.'}</span>
          </div>
        )}
        <p className="hero-note">
          The timer follows your HRMS clock: a break there pauses it, and checking out stops it.
        </p>
      </section>

      <div className="cards">
        <section className="card">
          <h2>
            <Icon name="cloud" /> Sync
          </h2>
          <dl className="facts">
            <dt>Waiting to upload</dt>
            <dd>
              {state.pendingCount} item{state.pendingCount === 1 ? '' : 's'}
              {state.pendingBytes > 0 && <span className="subtle"> · {formatBytes(state.pendingBytes)}</span>}
            </dd>
            <dt>Last sync</dt>
            <dd>{formatRelative(state.lastSyncAt)}</dd>
            <dt>Server</dt>
            <dd className="mono small server" title={state.apiBaseUrl}>
              {state.apiBaseUrl.replace(/^https?:\/\//, '')}
            </dd>
          </dl>
          <div className="meter" role="progressbar" aria-valuenow={Math.round(storagePct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`meter-fill ${storagePct >= 80 ? 'warn' : ''}`} style={{ width: `${storagePct}%` }} />
          </div>
          <div className="subtle small">
            Local storage: {formatBytes(state.pendingBytes)} of {formatBytes(state.storageLimitBytes)}
          </div>
          {state.lastError && <div className="error small">Last upload error: {state.lastError}</div>}
          <button className="btn" disabled={state.syncing} onClick={() => void window.tracker.syncNow()}>
            <Icon name="refresh" />
            {state.syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </section>

        <section className="card">
          <h2>
            <Icon name="shield" /> Permissions
          </h2>
          <ul className="checks">
            <Check ok={state.trackingAllowed}>HRMS allows tracking</Check>
            <Check ok={state.inputPermissionOk}>Mouse &amp; keyboard activity counting</Check>
            <Check ok={state.screenPermissionOk}>Screen capture</Check>
          </ul>
          <p className="fineprint">Only counts of clicks and key presses are recorded — never the keys or text you type.</p>
        </section>

        <section className="card">
          <h2>
            <Icon name="settings" /> Settings
          </h2>
          <label className="row">
            <input type="checkbox" checked={state.launchAtStartup} onChange={(e) => void window.tracker.setLaunchAtStartup(e.target.checked)} />
            Launch tracker when I sign in to this computer
          </label>
          <p className="fineprint">
            Closing the window keeps the tracker running in the system tray. Use <b>Quit</b> from the tray menu to exit (this
            stops tracking).
          </p>
          <button className="btn" disabled={busy} onClick={signOut}>
            <Icon name="logout" />
            Sign out
          </button>
        </section>
      </div>
    </div>
  )
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className={ok ? 'ok' : 'bad'}>
      <span className="check-icon">
        <Icon name={ok ? 'check' : 'alert'} size={13} />
      </span>
      {children}
    </li>
  )
}
