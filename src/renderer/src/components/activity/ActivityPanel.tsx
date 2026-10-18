import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActivityScreenshot, ActivityView, TrackerState } from '@shared/ipc'
import { summarize } from '../../lib/activity'
import { formatMinutes, todayLocal } from '../../lib/format'
import ActivityTimeline from './ActivityTimeline'
import Lightbox from './Lightbox'
import ScreenshotGrid from './ScreenshotGrid'
import StatCard from './StatCard'

/** "My activity" tab: daily totals, per-minute chart and screenshots for a chosen date. */
export default function ActivityPanel({ state }: { state: TrackerState }): React.JSX.Element {
  const [date, setDate] = useState(todayLocal)
  const [view, setView] = useState<ActivityView | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ActivityScreenshot | null>(null)
  /** Guards against an older, slower response overwriting a newer one. */
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const result = await window.tracker.getActivity(date)
      if (id === requestId.current) setView(result)
    } catch {
      if (id === requestId.current) setView({ date, logs: [], screenshots: [], fromServer: false, error: 'Could not load activity.' })
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [date])

  useEffect(() => {
    void load()
  }, [load])

  // Viewing today: refresh shortly after new data is queued or uploaded.
  useEffect(() => {
    if (date !== todayLocal()) return
    const t = setTimeout(() => void load(), 1500)
    return () => clearTimeout(t)
  }, [state.pendingCount, state.lastSyncAt, date, load])

  const summary = useMemo(() => summarize(view?.logs ?? []), [view])

  return (
    <div className="activity">
      <div className="toolbar">
        <input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {view?.error && <span className="muted small">{view.error}</span>}
      </div>

      <div className="stats">
        <StatCard label="Active" value={formatMinutes(summary.active)} tone="active" />
        <StatCard label="Inactive" value={formatMinutes(summary.inactive)} tone="inactive" />
        <StatCard label="Untracked" value={formatMinutes(summary.untracked)} tone="untracked" />
        <StatCard label="Mouse clicks" value={summary.clicks.toLocaleString()} />
        <StatCard label="Key presses" value={summary.keys.toLocaleString()} />
      </div>

      <section className="card">
        <h2>Activity by minute</h2>
        {view && view.logs.length > 0 ? (
          <ActivityTimeline logs={view.logs} />
        ) : (
          <p className="muted">{loading ? 'Loading…' : 'No tracked activity for this day.'}</p>
        )}
        <div className="legend">
          <span>
            <i className="sw active" /> Active
          </span>
          <span>
            <i className="sw inactive" /> Inactive
          </span>
          <span>
            <i className="sw untracked" /> Untracked
          </span>
          <span className="muted">Bar height = clicks + key presses in that minute</span>
        </div>
      </section>

      <section className="card">
        <h2>
          Screenshots {view && <span className="muted">({view.screenshots.length})</span>}
        </h2>
        {view && view.screenshots.length > 0 ? (
          <ScreenshotGrid shots={view.screenshots} onOpen={setOpen} />
        ) : (
          <p className="muted">No screenshots for this day.</p>
        )}
      </section>

      {open && <Lightbox shot={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
