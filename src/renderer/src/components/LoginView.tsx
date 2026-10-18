import { useState } from 'react'
import type { TrackerState } from '@shared/ipc'
import Icon, { BrandLogo } from './Icon'

/**
 * Sign-in with the employee's existing HRMS account. The server URL is pre-filled from
 * config (baked in for production builds) and only editable behind "change". Most people
 * never see this: Check in on the HRMS signs the app in through its link.
 */
export default function LoginView({ state }: { state: TrackerState }): React.JSX.Element {
  const [email, setEmail] = useState(state.user?.email ?? '')
  const [password, setPassword] = useState('')
  const [server, setServer] = useState(state.apiBaseUrl)
  const [editServer, setEditServer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.tracker.login(server, email, password)
      if (!res.ok) setError(res.error ?? 'Sign-in failed')
    } catch {
      setError('Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
      // Don't keep the password in memory longer than needed.
      setPassword('')
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={(e) => void submit(e)}>
        <div className="login-head">
          <div className="login-logo-card">
            <BrandLogo height={54} />
          </div>
          <div className="login-title">
            <h1>HRMS Tracker</h1>
            <p className="muted">Sign in with your Krishna HRMS account.</p>
          </div>
        </div>

        {state.notice && (
          <div className="callout">
            <Icon name="alert" />
            <span>{state.notice}</span>
          </div>
        )}
        {state.sessionStatus && (
          <div className="callout">
            <Icon name="clock" />
            <span>
              A tracking session is still running on this computer. Its data is saved locally and uploads after you sign
              in.
            </span>
          </div>
        )}

        <label>
          <span className="field-label">Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={320}
            required
            autoFocus
          />
        </label>
        <label>
          <span className="field-label">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={1000}
            required
          />
        </label>

        {editServer ? (
          <label>
            <span className="field-label">HRMS server URL</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://hrms.example.com" maxLength={300} />
          </label>
        ) : (
          <button type="button" className="link small" onClick={() => setEditServer(true)}>
            Server: {server} (change)
          </button>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="fineprint">
          Tip: press <b>Check in</b> on the HRMS and this app signs in by itself. While tracking is on, it records work
          time, the number of mouse clicks and key presses per minute, and periodic screenshots. It never records what you
          type.
        </p>
      </form>
    </div>
  )
}
