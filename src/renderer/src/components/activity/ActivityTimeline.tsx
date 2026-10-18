import { useState } from 'react'
import type { ActivityLogPayload } from '@shared/api-contract'
import { formatTime } from '../../lib/format'

const W = 1000
const H = 140
const MIN_SPAN_MS = 10 * 60_000

/**
 * Per-minute bar chart (SVG). x = time of day across the logged range; bar height = clicks
 * + keys for ACTIVE minutes, a thin bar for INACTIVE, full-height shaded for UNTRACKED.
 */
export default function ActivityTimeline({ logs }: { logs: readonly ActivityLogPayload[] }): React.JSX.Element {
  const [hover, setHover] = useState<ActivityLogPayload | null>(null)

  const start = Math.min(...logs.map((l) => Date.parse(l.intervalStart)))
  const end = Math.max(...logs.map((l) => Date.parse(l.intervalEnd)))
  const span = Math.max(end - start, MIN_SPAN_MS)
  const max = Math.max(1, ...logs.map((l) => l.mouseClickCount + l.keyboardEventCount))
  const x = (t: number): number => ((t - start) / span) * W

  // Hour (or 2-hour) tick marks.
  const step = span > 6 * 3_600_000 ? 2 * 3_600_000 : 3_600_000
  const ticks: number[] = []
  for (let t = Math.ceil(start / step) * step; t <= start + span; t += step) ticks.push(t)

  return (
    <div className="timeline">
      <svg viewBox={`0 0 ${W} ${H + 20}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)} role="img" aria-label="Activity by minute">
        <line x1={0} x2={W} y1={H} y2={H} className="axis" />
        {logs.map((l) => {
          const s = Date.parse(l.intervalStart)
          const e = Date.parse(l.intervalEnd)
          const total = l.mouseClickCount + l.keyboardEventCount
          const h = l.status === 'ACTIVE' ? Math.max(4, (total / max) * (H - 8)) : l.status === 'INACTIVE' ? 3 : H
          return (
            <rect
              key={l.id}
              x={x(s)}
              y={H - h}
              width={Math.max(1, x(e) - x(s) - 0.5)}
              height={h}
              className={`bar ${l.status.toLowerCase()}`}
              onMouseEnter={() => setHover(l)}
            />
          )
        })}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H + 15} className="tick">
            {formatTime(new Date(t).toISOString())}
          </text>
        ))}
      </svg>
      <div className="timeline-info muted small">
        {hover
          ? `${formatTime(hover.intervalStart)}–${formatTime(hover.intervalEnd)} · ${hover.status.toLowerCase()} · ${hover.mouseClickCount} clicks · ${hover.keyboardEventCount} keys`
          : 'Hover a bar for details'}
      </div>
    </div>
  )
}
