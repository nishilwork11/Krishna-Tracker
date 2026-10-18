import emblemUrl from '../assets/emblem.png'
import logoUrl from '../assets/logo.png'

/**
 * The handful of icons the window uses, drawn inline in the HRMS web app's style
 * (Lucide: 24px grid, 2px rounded strokes). Inline rather than a package: the window's
 * CSP allows nothing remote, and a dozen paths do not justify a dependency.
 */

const PATHS = {
  play: <path d="M7 4.5v15l12.5-7.5L7 4.5Z" />,
  pause: (
    <>
      <rect x="6.5" y="4.5" width="3.5" height="15" rx="1" />
      <rect x="14" y="4.5" width="3.5" height="15" rx="1" />
    </>
  ),
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2" />,
  refresh: (
    <>
      <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.3" />
      <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.7" />
      <path d="M20 4v4.7h-4.7M4 20v-4.7h4.7" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: (
    <>
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
      <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  coffee: (
    <>
      <path d="M17 8h1a3 3 0 0 1 0 6h-1" />
      <path d="M3 8h14v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8Z" />
      <path d="M7 2.5v2.5M11 2.5v2.5" />
    </>
  ),
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9.5H7Z" />,
  cloudOff: (
    <>
      <path d="M7 18.5a4.5 4.5 0 0 1-.5-8.97M10 4.3A6 6 0 0 1 18 9a4.5 4.5 0 0 1 2.7 7.9" />
      <path d="m3 3 18 18" />
    </>
  ),
  shield: <path d="M12 21s7.5-3.2 7.5-9.5V5.5L12 3 4.5 5.5v6C4.5 17.8 12 21 12 21Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  x: <path d="M18 6 6 18M6 6l12 12" />
} as const

export type IconName = keyof typeof PATHS

/** Media controls read better solid, as on any player. */
const FILLED: ReadonlySet<IconName> = new Set(['play', 'pause', 'stop'])

export default function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={FILLED.has(name) ? 1.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}

/** The Krishna Infotechs emblem (Lord Krishna silhouette & peacock feather). */
export function BrandMark({ size = 30, className = '' }: { size?: number, className?: string }): React.JSX.Element {
  return (
    <div className={`brand-mark-wrap ${className}`.trim()} style={{ width: size, height: size }}>
      <img src={emblemUrl} alt='Krishna Infotechs' className='brand-mark' style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    </div>
  )
}

/** The full Krishna Infotechs brand logo with text and tagline. */
export function BrandLogo({ height = 44, className = '' }: { height?: number, className?: string }): React.JSX.Element {
  return (
    <img
      src={logoUrl}
      alt='Krishna Infotechs - Intelligence • Innovation • Integrity'
      className={`brand-logo ${className}`.trim()}
      style={{ height, width: 'auto', objectFit: 'contain' }}
    />
  )
}
