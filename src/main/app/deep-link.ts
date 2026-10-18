/**
 * `krishnatracker://` links: how the HRMS web app reaches the desktop tracker.
 *
 *   krishnatracker://start?code=…&server=…&user=…   Check in / "Open desktop app" in the HRMS
 *   krishnatracker://open                            "Open tracker" in the HRMS
 *
 * The OS hands these to the app on the command line (Windows, Linux) or through
 * `open-url` (macOS). Any program or web page can open such a link, so nothing in it
 * is trusted: `code` is a single-use, short-lived sign-in code the server checks,
 * `server` must pass the same URL rules as a typed one and is confirmed by the
 * employee when it is new, and `user` only decides whether a sign-in is needed.
 */

export const DEEP_LINK_SCHEME = 'krishnatracker'

export interface DeepLink {
  action: 'start' | 'open'
  code: string | null
  server: string | null
  user: string | null
}

const PREFIX = `${DEEP_LINK_SCHEME}://`
const MAX_LINK_LENGTH = 2_000

function param(url: URL, name: string, max: number): string | null {
  const value = url.searchParams.get(name)?.trim()
  return value && value.length <= max ? value : null
}

/** Parses one link; null for anything that is not a well-formed tracker link. */
export function parseDeepLink(raw: string): DeepLink | null {
  if (raw.length > MAX_LINK_LENGTH || !raw.toLowerCase().startsWith(PREFIX)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // "krishnatracker://start" parses with the action as the host; tolerate a trailing slash.
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase()
  if (action !== 'start' && action !== 'open') return null
  return {
    action,
    code: param(url, 'code', 128),
    server: param(url, 'server', 300),
    user: param(url, 'user', 64)
  }
}

/** The tracker link among a process's command-line arguments, if there is one. */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const arg of argv) {
    const link = parseDeepLink(arg)
    if (link) return link
  }
  return null
}
