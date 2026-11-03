/**
 * When queued activity should go to the server.
 *
 * Activity is written once a minute, and one request per minute per employee is the single
 * biggest source of server calls. So while the timer runs, rows wait until the oldest has been
 * queued for `holdMs`, then go up together (the upload already accepts batches). Everything is
 * sent at once when nothing more is coming (timer paused or stopped), when the app is closing
 * or reconnecting (`forced`), or when batching is off (`holdMs` 0).
 */
export function activityUploadDue(
  oldestQueuedAt: number | null,
  now: number,
  holdMs: number,
  tracking: boolean,
  forced: boolean
): boolean {
  if (oldestQueuedAt === null) return false
  return forced || !tracking || holdMs <= 0 || now - oldestQueuedAt >= holdMs
}

/**
 * A minute with no input, from the last few minutes, while the timer runs. It may yet turn out
 * to be the start of an idle stretch that the idle check pauses, backdated: it then has to be
 * taken back (see retractActivity), which is only possible while it is still queued. So it waits
 * `holdMs` (longer than the idle check ever backdates). Minutes with input never wait for this.
 */
export function heldForIdle(
  row: { status: string; intervalEnd: string },
  now: number,
  holdMs: number,
  tracking: boolean
): boolean {
  return tracking && holdMs > 0 && row.status === 'INACTIVE' && Date.parse(row.intervalEnd) > now - holdMs
}
