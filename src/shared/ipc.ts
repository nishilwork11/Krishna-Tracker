/**
 * Contract between the Electron main process and the renderer (via the preload bridge).
 *
 * The renderer never touches Node, the filesystem or the network directly; everything
 * goes through the `TrackerApi` exposed on `window.tracker`.
 */
import type { ActivityLogPayload, HrmsClock, TrackerProject, UserInfo } from './api-contract'

/** IPC channel names. Kept in one place so main and preload cannot drift apart. */
export const IpcChannel = {
  GetState: 'tracker:getState',
  StateChanged: 'tracker:state',
  Login: 'tracker:login',
  Logout: 'tracker:logout',
  Start: 'tracker:start',
  Pause: 'tracker:pause',
  Resume: 'tracker:resume',
  Stop: 'tracker:stop',
  SyncNow: 'tracker:syncNow',
  GetActivity: 'tracker:getActivity',
  GetScreenshotImage: 'tracker:getScreenshotImage',
  SetLaunchAtStartup: 'tracker:setLaunchAtStartup',
  DismissNotice: 'tracker:dismissNotice'
} as const

/**
 * The single headline status shown to the employee.
 * Connectivity (online/offline/syncing) is reported separately in `TrackerState`
 * because it is orthogonal: a session can be active *and* offline.
 */
export type TrackerDisplayStatus = 'signed-out' | 'idle' | 'active' | 'paused' | 'permission-issue'

/** Snapshot of everything the UI renders. Pushed to the renderer on every change. */
export interface TrackerState {
  status: TrackerDisplayStatus
  user: UserInfo | null
  apiBaseUrl: string

  sessionId: string | null
  sessionStatus: 'ACTIVE' | 'PAUSED' | null
  /** The project the running session was started for, if any. */
  sessionProjectId: string | null
  /** Projects offered at Start (active HRMS projects the employee belongs to). */
  projects: TrackerProject[]
  startedAt: string | null
  /** Tracked (non-paused, non-untracked) ms as of `stateAt`; the UI extrapolates while ACTIVE. */
  elapsedMs: number
  stateAt: number

  online: boolean
  syncing: boolean
  pendingCount: number
  pendingBytes: number
  storageLimitBytes: number
  lastSyncAt: string | null
  lastError: string | null

  trackingAllowed: boolean
  trackingBlockedReason: string | null
  /** Where the employee's HRMS clock stands (null until the server has been asked). */
  hrmsClock: HrmsClock | null
  inputPermissionOk: boolean
  screenPermissionOk: boolean

  /** One-off message for the employee (e.g. "previous session was interrupted"). */
  notice: string | null
  launchAtStartup: boolean
}

export interface ActivityScreenshot {
  id: string
  capturedAt: string
  /** True while the image still lives only in the local queue. */
  pending: boolean
}

export interface ActivityView {
  date: string
  logs: ActivityLogPayload[]
  screenshots: ActivityScreenshot[]
  fromServer: boolean
  error: string | null
}

export interface ActionResult {
  ok: boolean
  error?: string
}

/** API exposed to the renderer as `window.tracker`. */
export interface TrackerApi {
  getState(): Promise<TrackerState>
  /** Subscribes to state pushes; returns an unsubscribe function. */
  onState(cb: (s: TrackerState) => void): () => void
  login(apiBaseUrl: string, email: string, password: string): Promise<ActionResult>
  logout(): Promise<void>
  /** Starts the timer, optionally for one of `TrackerState.projects`. */
  start(projectId?: string | null): Promise<ActionResult>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  syncNow(): Promise<void>
  /** `date` is a local calendar date, YYYY-MM-DD. */
  getActivity(date: string): Promise<ActivityView>
  /** Returns a `data:` URL, or null if the image is unavailable. */
  getScreenshotImage(id: string, pending: boolean): Promise<string | null>
  setLaunchAtStartup(enabled: boolean): Promise<void>
  dismissNotice(): Promise<void>
}
