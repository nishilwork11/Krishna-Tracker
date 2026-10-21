# Changelog

## 0.1.1
Smaller Windows installer, same app. Builds now use maximum NSIS (LZMA)
compression, and an `afterPack` step trims files the Windows x64 build never
loads before the installer is compressed: ~50 unused Chromium locale `.pak`
files (everything but `en-US`) and the native input-hook prebuilds for other
platforms. No behaviour or feature changes.

## 0.1.0
First release: start/pause/stop timer, per-minute activity counts, random-interval screenshots,
offline queue with retries, `krishnatracker://` sign-in from the HRMS, Windows installer.
