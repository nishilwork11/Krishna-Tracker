import { useEffect, useState } from 'react'
import type { TrackerState } from '@shared/ipc'

/**
 * Tracked milliseconds for the timer display. The main process only pushes state on
 * changes, so while ACTIVE the value is extrapolated locally from `elapsedMs` at `stateAt`.
 */
export function useElapsed(state: TrackerState): number {
  const [now, setNow] = useState(() => Date.now())
  const active = state.sessionStatus === 'ACTIVE'

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])

  return active ? state.elapsedMs + Math.max(0, now - state.stateAt) : state.elapsedMs
}
