import type { TrackerApi } from '../shared/ipc'

/** Type of the bridge exposed by preload/index.ts, available to renderer code. */
declare global {
  interface Window {
    tracker: TrackerApi
  }
}
