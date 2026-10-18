import { useEffect, useState } from 'react'
import type { TrackerState } from '@shared/ipc'

/**
 * Live tracker state from the main process. Subscribes before fetching the snapshot so
 * no push can be missed between the two; whichever arrives last wins (both are complete).
 */
export function useTrackerState(): TrackerState | null {
  const [state, setState] = useState<TrackerState | null>(null)
  useEffect(() => {
    let alive = true
    const unsubscribe = window.tracker.onState((s) => alive && setState(s))
    void window.tracker.getState().then((s) => {
      // Ignore the initial snapshot if a newer push already arrived.
      if (alive) setState((prev) => (prev && prev.stateAt > s.stateAt ? prev : s))
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  return state
}
