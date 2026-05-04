'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// macOS bundle name. Tauri uses `productName` from `tauri.conf.json`
// for the .app bundle, and zen-tools' productName is "Zen Tools" (with
// a space) — so the bundle on disk is literally `Zen Tools.app`.
const APP_BUNDLE_NAME = 'Zen Tools.app';

function pickMacInstallDir() {
  const system = '/Applications';
  if (isWritableDir(system)) return { dir: system, scope: 'system' };
  const userDir = path.join(os.homedir(), 'Applications');
  fs.mkdirSync(userDir, { recursive: true });
  return { dir: userDir, scope: 'user' };
}

function isWritableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function tempArtifactPath(filename) {
  return path.join(os.tmpdir(), filename);
}

module.exports = { APP_BUNDLE_NAME, pickMacInstallDir, isWritableDir, tempArtifactPath };
