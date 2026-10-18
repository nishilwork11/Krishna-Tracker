# HRMS Desktop Time & Activity Tracker

This repo implements the plan in [docs/Tracker_hrms.pdf](docs/Tracker_hrms.pdf) (v2).

| Component | Location / Description |
|---|---|
| This repo | The Electron + React + TypeScript desktop tracker (builds a Windows installer) |
| Backend API | Lives in the `krishna-hrms` repo (`src/app/api/tracker/**`, `src/server/tracker.ts`), built on the HRMS's accounts, devices, and screenshot storage. |

The desktop app only talks to the HRMS backend over HTTPS. It never connects to the database and holds no database credentials.

## How it connects to the HRMS

Employees start the timer from the HRMS web app. **Start timer** (on My Day and the dashboard) opens a `krishnatracker://start?code=…&server=…&user=…` link:

1. The OS hands the link to this app (the installer registers the scheme; the app also registers it on launch).
2. If the app is already signed in as that person on that server, it just starts the timer.
3. Otherwise it trades the single-use `code` at `POST /api/tracker/auth/link` for a device token, so there is no password to type. A link naming a server the app has not used before is confirmed in a dialog first.
4. The HRMS then shows the running timer, tracked time, activity and screenshots. Admins see everyone in scope under **Monitoring**.

Tracking follows the HRMS clock: `/api/tracker/me` says the timer may run only while the employee is checked in and working, and also returns the company's **screenshots per hour**. The app schedules captures within ±25% of that spacing.

The HRMS answers `410 Gone` for records it will never accept (for example, monitoring was switched off), and the app drops them instead of retrying.

To try the link flow against the mock server: open `http://localhost:4000/admin/link?user=emp_alice` and paste the returned link into the browser's address bar.

## Quick start (no HRMS needed)

Requires Node.js 22+ on Windows. From the repo root, install once with `npm ci`, then use two terminals:

```powershell
npm run mock-server        # terminal 1: in-memory HRMS API on http://localhost:4000
npm run dev                # terminal 2: the app, with hot reload
```

Sign in with `alice@example.com` / `password`. Open http://localhost:4000/admin to see what the "server" received.

To get screenshots every ~20 s instead of every 8–12 min, use `npm run dev:fast` (or `npm run dev:fast -- 10` for ~10 s). This override only works in development builds.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:fast` | Run the app in development |
| `npm run typecheck` | TypeScript check for the main process, preload and renderer |
| `npm run test:e2e` | Build, then run the end-to-end suite against a private mock server (see below) |
| `npm run dist` | Typecheck, build, and produce `dist/HRMS-Desktop-Tracker-Setup.exe` |

No Visual Studio/C++ toolchain is needed. Local storage uses Electron's built-in `node:sqlite`, and the input hook (`uiohook-napi`) ships prebuilt N-API binaries.

## Code structure

```
src/
├── shared/                 Types shared by every process
│   ├── api-contract.ts       HTTP request/response shapes (mirrors krishna-hrms API)
│   └── ipc.ts                IPC channel names, TrackerState, the window.tracker API
├── main/                   Electron main process
│   ├── index.ts              Entry point: single instance, lifecycle, quit/shutdown flow
│   ├── app/                  UI shell: hardened window, tray, IPC handlers, icons
│   ├── core/                 Domain logic
│   │   ├── tracker-service.ts   Orchestrator, the only thing the UI layer talks to
│   │   ├── session-tracker.ts   Session state machine and per-minute activity buckets
│   │   ├── input-monitor.ts     Global click/key counting (counts only, never keys)
│   │   ├── screenshot-service.ts Random-interval capture, encryption, storage cap
│   │   └── sync-engine.ts       Outbox uploader: ordering, retries, backoff, isolation
│   ├── data/                 SQLite: migrations + corruption recovery, outbox, key/value
│   ├── platform/             Config, file logging, secure storage, HTTP client, paths
│   └── dev/selftest.ts       End-to-end self-tests (disabled in packaged builds)
├── preload/                Sandboxed bridge exposing window.tracker
└── renderer/src/           React UI: components/, hooks/, lib/, styles/
```

Data flows one way: `core` writes to the local outbox, `sync-engine` uploads it, and `tracker-service` pushes a fresh `TrackerState` snapshot to the window and tray on every change.

## How the desktop app behaves

| Area | Behaviour |
|---|---|
| Sign-in | Same HRMS account. The token is encrypted with the OS keychain (DPAPI on Windows). Server URLs must use HTTPS (plain HTTP only for localhost), and redirects are refused so the token can't be forwarded elsewhere. |
| Controls | Start, pause, resume, stop; live timer; status; connected/offline/syncing; pending count; last sync; last upload error |
| Visible indicator | The tray icon is green while tracking and amber while paused. A notification appears on start, and again the first time the window is hidden while tracking. |
| Activity | Mouse-button and key presses are **counted** per minute. Key codes, characters and cursor positions are never read. |
| Minute status | `ACTIVE` (any input), `INACTIVE` (none), `UNTRACKED` (sleep gap, or input permission unavailable) |
| Screenshots | One JPEG per display at a random 8–12 min interval while active. Skipped while the screen is locked. Missed deadlines are never caught up. |
| Offline | Everything goes to the local SQLite outbox first. Screenshots are stored as AES-256-GCM encrypted files. A row is deleted only after the server confirms it. |
| Retries | Server/network trouble backs off from 5 s up to 5 min. A record the server rejects backs off from 1 min up to 1 h and never blocks other records. Errors are shown in the app. |
| Duplicates | Every record carries a client UUID that the server treats as an idempotency key, including when two retries arrive at the same moment. |
| Close window | Hides to the tray; tracking continues. |
| Quit (tray) | Confirms ("Quitting will stop tracking"), ends the session `COMPLETED`, and makes a bounded final upload. |
| OS shutdown / logoff | Ends the session `INTERRUPTED` immediately; no dialog can block the shutdown. |
| Crash / power loss | On next launch, the session is closed `INTERRUPTED` at its last heartbeat (at most 15 s lost), uploaded, and an alert is queued. |
| Sleep | Gaps under 30 min are logged `UNTRACKED`. Longer gaps end the session `INTERRUPTED`. |
| Clock changes | A backward jump closes the current minute and continues, and the timer stays continuous. A forward jump is treated like sleep. |
| Storage cap | Default 500 MB pending. At 80% the employee is warned and an admin alert is queued; at 100% screenshots pause. |
| Robustness | Schema migrations. A corrupt database is set aside and recreated. Config is validated and clamped. Logs go to `%APPDATA%\HRMS Desktop Tracker\logs\main.log` (rotated at 5 MB). |

## Tests

`npm run test:e2e` starts a private mock server on port 4100 and runs each scenario against a temporary profile, so your real data is untouched:

| Scenario | Verifies |
|---|---|
| full | Sign-in → start → screenshot → 5 synthetic Shift presses counted → minute rollover → pause/resume → stop → upload → read back. Also checks that test-only config never reaches `config.json`. |
| offline | Server unreachable: session, activity and screenshot stay queued, then drain on reconnect |
| crash + recover | Process killed mid-session → next launch uploads it as `INTERRUPTED` with an alert |
| poison | A record the server rejects is kept with backoff and reported, while valid records still upload |

## Deploying and connecting to krishna-hrms on Vercel

1. **Deploy the backend.** In the `krishna-hrms` repo, apply the `20261016000000_desktop_tracker` migration to the production database (`npx prisma migrate deploy` if it uses Prisma), then deploy to Vercel (push to the connected branch, or `vercel --prod`). Confirm the `/api/tracker/**` routes exist: for example `https://krishna-hrms.vercel.app/api/tracker/me` should answer `401`, not `404`.
2. **Enable monitoring** in the HRMS under Settings → Work pattern, and set the screenshots-per-hour value.
3. **Server URL.** `.env.production` (committed; it holds only the public URL) sets `MAIN_VITE_HRMS_API_URL=https://krishna-hrms.vercel.app`. It is baked in at build time, so edit it and rebuild to point at another deployment.
4. **Release.** Bump `version` in `package.json` (and `CHANGELOG.md`), commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The Release workflow builds `HRMS-Desktop-Tracker-Setup.exe` and attaches it to a GitHub Release. To build locally instead: `npm ci && npm run dist` (output in `dist/`). Optional signing: add repository secrets `CSC_LINK` and `CSC_KEY_PASSWORD`.
5. **Distribute.** In the HRMS set **Settings → Work pattern → Agent download URL** to `https://github.com/nishilwork11/Krishna-Tracker/releases/latest/download/HRMS-Desktop-Tracker-Setup.exe` (stable across versions; the repo must be public for employees to download it). Employees then press **Start timer**, which opens the app via `krishnatracker://` and signs it in with a one-time code.
6. **Verify end to end:** start a timer, wait for a screenshot, then check the Monitoring page in the HRMS and `%APPDATA%\HRMS Desktop Tracker\logs\main.log`.

## Production checklist

1. Check `MAIN_VITE_HRMS_API_URL` in `.env.production`.
2. Deploy krishna-hrms with the `20261016000000_desktop_tracker` migration, and switch on monitoring in its Settings → Work pattern.
3. Get a code-signing certificate and configure it in electron-builder. Unsigned installers trigger SmartScreen warnings and are often blocked by antivirus.
4. Bump `version` in `package.json`, then run `npm run dist`.
5. Pilot on a few machines and check `logs\main.log` and the HRMS data before rolling out.

## Not built yet

- Auto-update (for example, electron-updater with a release feed).
- macOS build (Screen Recording and Accessibility permission flows are untested).
