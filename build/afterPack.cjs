"use strict";

/**
 * electron-builder afterPack hook: trim files from the packaged app that this
 * Windows x64 build never loads, before NSIS compresses everything into the
 * installer. Two easy, safe wins on top of `compression: maximum`:
 *
 *   1. Chromium ships ~55 locale `.pak` files (de, es, zh-CN, …). The tracker's
 *      UI is English only, so every locale but en-US is dead weight (~10 MB).
 *   2. uiohook-napi ships prebuilt native binaries for every OS/arch. An x64
 *      Windows build only ever loads win32-x64; the rest (~0.4 MB) are unused.
 *
 * Everything here is best-effort and guarded: if a path is missing or cannot be
 * removed, the build still succeeds — it just ships a slightly larger installer.
 */

const fs = require("node:fs");
const path = require("node:path");

/** The only Chromium locale the app uses. */
const KEEP_LOCALES = new Set(["en-US.pak"]);
/** The only native input-hook prebuild an x64 Windows build loads. */
const KEEP_PREBUILD = "win32-x64";

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function pruneLocales(appOutDir) {
  const dir = path.join(appOutDir, "locales");
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return; // no locales folder in this layout — nothing to prune
  }
  let removed = 0;
  let freed = 0;
  for (const file of files) {
    if (!file.endsWith(".pak") || KEEP_LOCALES.has(file)) continue;
    const full = path.join(dir, file);
    try {
      freed += fs.statSync(full).size;
      fs.rmSync(full);
      removed += 1;
    } catch {
      /* leave anything locked or already gone */
    }
  }
  console.log(`[afterPack] removed ${removed} unused Chromium locales (${mb(freed)} before compression)`);
}

function prunePrebuilds(appOutDir) {
  const dir = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "uiohook-napi",
    "prebuilds",
  );
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // module not unpacked here — nothing to prune
  }
  let removed = 0;
  let freed = 0;
  for (const entry of entries) {
    if (entry === KEEP_PREBUILD) continue;
    const full = path.join(dir, entry);
    try {
      freed += dirSize(full);
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  console.log(`[afterPack] removed ${removed} non-${KEEP_PREBUILD} native prebuilds (${mb(freed)} before compression)`);
}

exports.default = async function afterPack(context) {
  // Only the Windows build ships today; leave any future mac/linux build alone.
  if (context.electronPlatformName !== "win32") return;
  pruneLocales(context.appOutDir);
  prunePrebuilds(context.appOutDir);
};
