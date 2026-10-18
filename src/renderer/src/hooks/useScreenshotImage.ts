import { RefObject, useEffect, useState } from 'react'

/**
 * Loads a screenshot as a data URL via the main process.
 * Returns undefined while loading, null if unavailable.
 *
 * Pass `lazyRef` to defer loading until the element scrolls into view, so a day with
 * many screenshots doesn't pull every full image into memory at once.
 */
export function useScreenshotImage(
  id: string,
  pending: boolean,
  lazyRef?: RefObject<Element | null>
): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const [visible, setVisible] = useState(!lazyRef)

  useEffect(() => {
    if (!lazyRef?.current || visible) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(lazyRef.current)
    return () => observer.disconnect()
  }, [lazyRef, visible])

  useEffect(() => {
    if (!visible) return
    let alive = true
    setSrc(undefined)
    window.tracker
      .getScreenshotImage(id, pending)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setSrc(null))
    return () => {
      alive = false
    }
  }, [id, pending, visible])

  return src
}
