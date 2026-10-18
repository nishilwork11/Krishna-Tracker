/**
 * HTTP contract between the desktop app and the HRMS backend.
 *
 * This file is the single source of truth for request/response shapes.
 * The server-side implementation lives in the krishna-hrms repo
 * (`src/app/api/tracker/**`, `src/server/tracker.ts`) and the mock in
 * `desktop/scripts/mock-server.mjs`. Keep all three in sync.
 *
 * Conventions:
 *  - All timestamps are ISO-8601 strings in UTC.
 *  - All record ids are UUIDv4 generated on the desktop. They double as
 *    idempotency keys: re-sending a record with the same id is a no-op.
 *  - Errors are `{ error }`. 409 means "already stored" and 410 means "the
 *    server will never accept this" (e.g. monitoring was switched off); both
 *    remove the record from the outbox. Anything else is retried.
 */

export type SessionStatus = 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'INTERRUPTED'
export type ActivityStatus = 'ACTIVE' | 'INACTIVE' | 'UNTRACKED'
/**
 * Where the employee's HRMS clock stands; the timer follows it. `break` pauses a running
 * timer (Resume in the HRMS resumes it); `off` — not checked in, checked out, on leave —
 * stops it.
 */
export type HrmsClock = 'working' | 'break' | 'off'

export type AlertType = 'STORAGE_NEARLY_FULL' | 'STORAGE_FULL' | 'PERMISSION_UNAVAILABLE' | 'SESSION_INTERRUPTED'

export interface UserInfo {
  id: string
  name: string
  email: string
}

/** POST /api/tracker/auth/login `{ email, password }` and POST /api/tracker/auth/link `{ code }` */
export interface LoginResponse {
  token: string
  expiresAt: string
  user: UserInfo
  trackingAllowed: boolean
  clock?: HrmsClock
  reason?: string
  /** The company's capture cadence; the app schedules screenshots around it. */
  screenshotsPerHour?: number
}

/** GET /api/tracker/me — also serves as the "tracker is connected" heartbeat. */
export interface MeResponse {
  user: UserInfo
  trackingAllowed: boolean
  /** Where the HRMS clock stands. Absent from older servers: fall back to `trackingAllowed`. */
  clock?: HrmsClock
  /** Human-readable reason shown to the employee when tracking is not allowed. */
  reason?: string
  screenshotsPerHour?: number
}

/** PUT /api/tracker/sessions/:id — full state, latest write wins. */
export interface SessionPayload {
  id: string
  startedAt: string
  endedAt: string | null
  status: SessionStatus
  lastActivityAt: string | null
  pausedSeconds: number
  /** The HRMS project picked at Start, if any. Fixed by the server when the session is first stored. */
  projectId?: string | null
}

/** One element of GET /api/tracker/projects `{ projects }`: active projects the employee is a member of. */
export interface TrackerProject {
  id: string
  key: string
  name: string
  color: string
}

/** One element of POST /api/tracker/activity `{ logs: [...] }`. Usually one minute long. */
export interface ActivityLogPayload {
  id: string
  sessionId: string
  intervalStart: string
  intervalEnd: string
  mouseClickCount: number
  keyboardEventCount: number
  status: ActivityStatus
}

/** POST /api/tracker/screenshots */
export interface ScreenshotPayload {
  id: string
  sessionId: string
  capturedAt: string
  mimeType: 'image/jpeg'
  imageBase64: string
  /** A small JPEG preview, so the HRMS admin grid never loads full frames. */
  thumbBase64?: string
  width?: number
  height?: number
}

/** POST /api/tracker/alerts */
export interface AlertPayload {
  id: string
  type: AlertType
  message: string
  createdAt: string
}

/** GET /api/tracker/screenshots?date=&tz= */
export interface ServerScreenshot {
  id: string
  sessionId: string
  capturedAt: string
}
