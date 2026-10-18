import { app } from 'electron'
import type {
  ActivityLogPayload,
  AlertPayload,
  LoginResponse,
  MeResponse,
  ScreenshotPayload,
  ServerScreenshot,
  SessionPayload,
  TrackerProject
} from '@shared/api-contract'

/**
 * HTTP client for the HRMS tracker API (see shared/api-contract.ts).
 *
 * Errors are normalised into three classes so callers can react correctly:
 *   NetworkError: server unreachable or timed out → app goes "offline", retries later
 *   AuthError:    401 → token invalid/revoked → employee must sign in again
 *   HttpError:    any other non-2xx → `retryable` tells whether a retry can help
 */

export class NetworkError extends Error {
  override name = 'NetworkError'
}

export class AuthError extends Error {
  override name = 'AuthError'
}

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }

  /** 5xx, 408 and 429 are transient; other 4xx mean the request itself is wrong. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429
  }
}

const DEFAULT_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 60_000
/** Short timeout for interactive checks so the UI never hangs on a slow server. */
const QUICK_TIMEOUT_MS = 6_000

/**
 * Validates a server URL entered by the employee. Plain HTTP is only allowed for
 * loopback addresses (local development); anything else must use HTTPS so the
 * password and token are never sent in clear text.
 * Returns an error message, or null if the URL is acceptable.
 */
export function validateServerUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'Enter a valid server URL, e.g. https://hrms.example.com'
  }
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
  return 'The server URL must start with https://'
}

export class ApiClient {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private token: string | null = null
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  get serverUrl(): string {
    return this.baseUrl
  }

  // ------------------------------------------------------------ endpoints

  login(email: string, password: string): Promise<LoginResponse> {
    return this.json('POST', '/api/tracker/auth/login', { email, password }, QUICK_TIMEOUT_MS * 2)
  }

  /** Signs in with the single-use code from the HRMS "Start timer" link. */
  redeemLink(code: string): Promise<LoginResponse> {
    return this.json('POST', '/api/tracker/auth/link', { code }, QUICK_TIMEOUT_MS * 2)
  }

  logout(): Promise<void> {
    return this.json('POST', '/api/tracker/auth/logout', {}, QUICK_TIMEOUT_MS)
  }

  me(): Promise<MeResponse> {
    return this.json('GET', '/api/tracker/me', undefined, QUICK_TIMEOUT_MS)
  }

  /** Active HRMS projects the employee may track time against. */
  getProjects(): Promise<{ projects: TrackerProject[] }> {
    return this.json('GET', '/api/tracker/projects', undefined, QUICK_TIMEOUT_MS)
  }

  upsertSession(s: SessionPayload): Promise<unknown> {
    return this.json('PUT', `/api/tracker/sessions/${encodeURIComponent(s.id)}`, s)
  }

  uploadActivity(logs: ActivityLogPayload[]): Promise<{ stored: number }> {
    return this.json('POST', '/api/tracker/activity', { logs })
  }

  uploadScreenshot(s: ScreenshotPayload): Promise<unknown> {
    return this.json('POST', '/api/tracker/screenshots', s, UPLOAD_TIMEOUT_MS)
  }

  sendAlert(a: AlertPayload): Promise<unknown> {
    return this.json('POST', '/api/tracker/alerts', a)
  }

  getActivity(date: string): Promise<{ logs: ActivityLogPayload[] }> {
    return this.json('GET', `/api/tracker/activity?date=${encodeURIComponent(date)}&tz=${tzOffsetMinutes()}`)
  }

  getScreenshots(date: string): Promise<{ screenshots: ServerScreenshot[] }> {
    return this.json('GET', `/api/tracker/screenshots?date=${encodeURIComponent(date)}&tz=${tzOffsetMinutes()}`)
  }

  /** Downloads one of the employee's own screenshots as a `data:` URL. */
  async getScreenshotDataUrl(id: string): Promise<string> {
    const res = await this.send('GET', `/api/tracker/screenshots/${encodeURIComponent(id)}/image`, undefined, UPLOAD_TIMEOUT_MS)
    const type = res.headers.get('content-type') ?? 'image/jpeg'
    if (!type.startsWith('image/')) throw new HttpError(415, 'Server returned a non-image response')
    const buf = Buffer.from(await res.arrayBuffer())
    return `data:${type};base64,${buf.toString('base64')}`
  }

  // ------------------------------------------------------------ transport

  private async json<T>(method: string, path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const res = await this.send(method, path, body, timeoutMs)
    if (res.status === 204) return undefined as T
    try {
      return (await res.json()) as T
    } catch {
      throw new HttpError(502, 'Server returned an invalid response')
    }
  }

  private async send(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Tracker-Version': app.getVersion(),
      'X-Tracker-Platform': process.platform
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects: a redirect could forward the bearer token elsewhere.
        redirect: 'error'
      })
    } catch (e) {
      throw new NetworkError((e as Error).message || 'Network unavailable')
    }

    if (res.status === 401) throw new AuthError('Your sign-in has expired. Please sign in again.')
    if (!res.ok) throw new HttpError(res.status, await errorMessage(res))
    return res
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error.slice(0, 300)
  } catch {
    /* non-JSON error body */
  }
  return `${res.status} ${res.statusText}`.trim()
}

/** Minutes east of UTC, so the server can resolve the employee's local calendar day. */
function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}
