import { useRef } from 'react'
import type { ActivityScreenshot } from '@shared/ipc'
import { useScreenshotImage } from '../../hooks/useScreenshotImage'
import { formatTime } from '../../lib/format'

/** Thumbnail grid. Images load lazily as they scroll into view. */
export default function ScreenshotGrid({
  shots,
  onOpen
}: {
  shots: readonly ActivityScreenshot[]
  onOpen: (shot: ActivityScreenshot) => void
}): React.JSX.Element {
  return (
    <div className="shots">
      {shots.map((s) => (
        <Thumb key={s.id} shot={s} onOpen={() => onOpen(s)} />
      ))}
    </div>
  )
}

function Thumb({ shot, onOpen }: { shot: ActivityScreenshot; onOpen: () => void }): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  const src = useScreenshotImage(shot.id, shot.pending, ref)
  return (
    <button ref={ref} className="shot" onClick={onOpen} aria-label={`Open screenshot from ${formatTime(shot.capturedAt)}`}>
      {src ? <img src={src} alt="" /> : <div className="shot-ph">{src === null ? 'Unavailable' : '…'}</div>}
      <span className="shot-meta">
        {formatTime(shot.capturedAt)}
        {shot.pending && <em className="tag">pending upload</em>}
      </span>
    </button>
  )
}
