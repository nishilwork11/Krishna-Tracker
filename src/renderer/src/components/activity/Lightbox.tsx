import { useEffect } from 'react'
import type { ActivityScreenshot } from '@shared/ipc'
import { useScreenshotImage } from '../../hooks/useScreenshotImage'

/** Full-size screenshot overlay. Closes on Escape, backdrop click or the Close button. */
export default function Lightbox({ shot, onClose }: { shot: ActivityScreenshot; onClose: () => void }): React.JSX.Element {
  const src = useScreenshotImage(shot.id, shot.pending)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="Screenshot">
      <figure onClick={(e) => e.stopPropagation()}>
        {src ? <img src={src} alt="" /> : <div className="shot-ph big">{src === null ? 'Unavailable' : 'Loading…'}</div>}
        <figcaption>
          {new Date(shot.capturedAt).toLocaleString()}
          {shot.pending && ' · pending upload'}
          <button className="btn" onClick={onClose} autoFocus>
            Close
          </button>
        </figcaption>
      </figure>
    </div>
  )
}
