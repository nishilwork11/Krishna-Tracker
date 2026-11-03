# Changelog

## 0.2.0
- Idle check: after 5 minutes without keyboard or mouse input anywhere on the computer, a small
  always-on-top "Are you still working?" card appears (independent of Windows notification settings).
  Clicking it, or simply returning to the keyboard, keeps the timer running. With no answer in
  3 minutes the timer pauses from when the inactivity began and resumes on the first input.
  The timer is never paused unless the card was actually on screen. A locked screen pauses without a card.
- On for everyone by default. IT can turn it off with `idleDetection: false` in config.json; times are
  `idlePromptMinutes` and `idleResponseMinutes`.
- Test quickly with `TRACKER_IDLE_SECONDS=20` in an unpackaged run. Logic tests: `npm run test:idle`.

- Far fewer calls to the HRMS (about 70% fewer per employee per day, so less Vercel compute):
  - activity goes up in batches every 5 minutes while the timer runs (immediately on pause, stop, close or reconnect);
  - the timer / HRMS-clock check runs every 2 minutes instead of every minute, so a break or check-out in the HRMS can take up to 2 minutes to reach the timer;
  - the Start picker's project list is fetched at most every 15 minutes, never while a timer runs, and always fresh at Start.
- With no timer open, the check runs every 5 minutes (`permissionCheckIdleMinutes`); with one open, every 2.
- Screenshots are smaller by default (1280 px wide, JPEG quality 50; still the whole screen).
- New setting `activityUploadMinutes` (0 = every minute, as before).

## 0.1.0
First release: start/pause/stop timer, per-minute activity counts, random-interval screenshots,
offline queue with retries, `krishnatracker://` sign-in from the HRMS, Windows installer.
