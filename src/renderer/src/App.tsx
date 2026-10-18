import { useState } from 'react'
import ActivityPanel from './components/activity/ActivityPanel'
import Icon, { BrandMark } from './components/Icon'
import LoginView from './components/LoginView'
import TrackerPanel from './components/TrackerPanel'
import { useTrackerState } from './hooks/useTrackerState'

type Tab = 'tracker' | 'activity'

/** Top-level shell: login screen when signed out, otherwise header + tabs. */
export default function App(): React.JSX.Element {
  const state = useTrackerState()
  const [tab, setTab] = useState<Tab>('tracker')

  if (!state) return <div className="loading">Loading…</div>
  if (state.status === 'signed-out') return <LoginView state={state} />

  const dotTone = state.sessionStatus === 'ACTIVE' ? 'active' : state.sessionStatus === 'PAUSED' ? 'paused' : 'idle'

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <strong>HRMS Tracker</strong>
            <span>Krishna Infotechs</span>
          </div>
        </div>

        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'tracker'} className={tab === 'tracker' ? 'tab on' : 'tab'} onClick={() => setTab('tracker')}>
            <span className={`dot dot-${dotTone}`} aria-hidden />
            Tracker
          </button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'tab on' : 'tab'} onClick={() => setTab('activity')}>
            My activity
          </button>
        </nav>

        <div className="who" title={state.user?.email}>
          <span className="avatar" aria-hidden>
            {initials(state.user?.name ?? '')}
          </span>
          <span className="who-name">{state.user?.name}</span>
        </div>
      </header>

      {state.notice && (
        <div className="banner" role="status">
          <Icon name="alert" />
          <span className="banner-text">{state.notice}</span>
          <button className="icon-btn" onClick={() => void window.tracker.dismissNotice()} aria-label="Dismiss">
            <Icon name="x" />
          </button>
        </div>
      )}

      <main className="content">{tab === 'tracker' ? <TrackerPanel state={state} /> : <ActivityPanel state={state} />}</main>
    </div>
  )
}

/** "Sara Khan" → "SK", as the HRMS avatars show it. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase() || '?'
}
