import type { ActivityLogPayload } from '@shared/api-contract'

export interface ActivitySummary {
  /** Minutes in each status. */
  active: number
  inactive: number
  untracked: number
  clicks: number
  keys: number
}

/** Totals for a list of activity intervals (intervals may be partial minutes). */
export function summarize(logs: readonly ActivityLogPayload[]): ActivitySummary {
  const r: ActivitySummary = { active: 0, inactive: 0, untracked: 0, clicks: 0, keys: 0 }
  for (const l of logs) {
    const minutes = Math.max(0, Date.parse(l.intervalEnd) - Date.parse(l.intervalStart)) / 60_000
    if (l.status === 'ACTIVE') r.active += minutes
    else if (l.status === 'INACTIVE') r.inactive += minutes
    else r.untracked += minutes
    r.clicks += l.mouseClickCount
    r.keys += l.keyboardEventCount
  }
  return r
}
