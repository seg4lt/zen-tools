'use strict';
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');

const { download } = require('./download');
const { tempArtifactPath } = require('./paths');
const { windowsAssetName, windowsUrl } = require('./release');
const {
  findInstall,
  resolveMainExe,
  diagnosticDump,
  extractUninstallerPath,
} = require('./windows-registry');

async function installWindows({ tag, launch = true, quiet = false } = {}) {
  if (!tag) throw new Error('installWindows: tag is required');
  if (process.platform !== 'win32') {
    throw new Error(
      `installWindows called on non-win32 platform: ${process.platform}`,
    );
  }
  if (process.arch !== 'x64') {
    throw new Error(
      `No ${process.arch} Windows build is published. See https://github.com/seg4lt/zen-tools/releases for available downloads.`,
    );
  }

  const exeUrl = windowsUrl(tag);
  const exePath = tempArtifactPath(windowsAssetName(tag));

  log(quiet, `==> Downloading ${exeUrl}`);
  await download(exeUrl, exePath, { quiet });

  log(quiet, '==> Running installer (silent)');
  const result = spawnSync(exePath, ['/S'], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Installer exited with ${result.status}`);
  }

  try {
    fs.unlinkSync(exePath);
  } catch {}

  let entry = null;
  try {
    entry = findInstall();
  } catch (err) {
    log(quiet, `note: registry lookup failed: ${err.message}`);
  }

  if (!entry) {
    log(
      quiet,
      'note: install completed but no zen-tools-matching registry entry was found. Dumping diagnostic info from the Uninstall hives so we can see what NSIS actually wrote.',
    );
    try {
      log(quiet, JSON.stringify(diagnosticDump(20), null, 2));
    } catch (err) {
      log(quiet, `(diagnostic dump failed: ${err.message})`);
    }
    return { installedAt: null };
  }

  const installedExe = resolveMainExe(entry);
  const reportedDir =
    entry.installLocation ||
    (entry.uninstallString
      ? require('node:path').dirname(
          extractUninstallerPath(entry.uninstallString) || '',
        )
      : null) ||
    '(unknown dir)';
  log(quiet, `==> Installed to ${reportedDir}`);

  if (!installedExe) {
    log(
      quiet,
      'note: registry entry matched but no Zen Tools exe was found in the install dir. Launch via the Start Menu shortcut. Registry entry + dir listing below:',
    );
    log(quiet, JSON.stringify(entry, null, 2));
    try {
      const files = require('node:fs').readdirSync(reportedDir);
      log(quiet, `Install dir contents (${reportedDir}):`);
      for (const f of files) log(quiet, `  ${f}`);
    } catch (err) {
      log(quiet, `(could not list ${reportedDir}: ${err.message})`);
    }
    return { installedAt: null, registryEntry: entry };
  }

  if (launch) {
    log(quiet, '==> Launching Zen Tools');
    const child = spawn(installedExe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  return { installedAt: installedExe, registryEntry: entry };
}

function log(quiet, msg) {
  if (!quiet) process.stderr.write(`${msg}\n`);
}

module.exports = { installWindows };
