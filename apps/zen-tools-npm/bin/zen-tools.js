#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { fetchLatestTag, normalizeTag } = require('../lib/release');
const { APP_BUNDLE_NAME } = require('../lib/paths');

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  if (flags.help) { printUsage(); process.exit(0); }
  if (flags.version) {
    process.stdout.write(`@seg4lt/zen-tools v${pkg.version}\n`);
    process.exit(0);
  }

  const cmd = flags.positional[0] || 'install';
  switch (cmd) {
    case 'install':
      await runInstall({ version: flags.versionArg, launch: flags.launch, quiet: flags.quiet });
      break;
    case 'update':
      await runUpdate({ launch: flags.launch, quiet: flags.quiet });
      break;
    case 'launch':
      runLaunch({ quiet: flags.quiet });
      break;
    case 'uninstall':
      runUninstall({ quiet: flags.quiet });
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${cmd}\n\n`);
      printUsage();
      process.exit(2);
  }
}

async function runInstall({ version, launch, quiet }) {
  if (!version) return runUpdate({ launch, quiet });
  const tag = normalizeTag(version);
  if (tag === 'latest') return runUpdate({ launch, quiet });
  await dispatchPlatform(tag, { launch, quiet });
}

async function runUpdate({ launch, quiet }) {
  if (!quiet) process.stderr.write('==> Resolving latest release\n');
  const tag = await fetchLatestTag();
  if (!quiet) process.stderr.write(`    Latest is ${tag}\n`);
  await dispatchPlatform(tag, { launch, quiet });
}

async function dispatchPlatform(tag, opts) {
  if (process.platform === 'darwin') {
    const { installMac } = require('../lib/install-macos');
    await installMac({ tag, ...opts });
    return;
  }
  if (process.platform === 'win32') {
    const { installWindows } = require('../lib/install-windows');
    await installWindows({ tag, ...opts });
    return;
  }
  if (process.platform === 'linux') {
    process.stderr.write('Linux is not currently published. Track https://github.com/seg4lt/zen-tools to be notified when it is.\n');
    process.exit(1);
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function runLaunch({ quiet }) {
  if (process.platform === 'darwin') {
    const candidates = [
      path.join('/Applications', APP_BUNDLE_NAME),
      path.join(require('node:os').homedir(), 'Applications', APP_BUNDLE_NAME),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      process.stderr.write(`${APP_BUNDLE_NAME} not found. Run \`zen-tools install\` first.\n`);
      process.exit(1);
    }
    spawnSync('open', [found], { stdio: quiet ? 'ignore' : 'inherit' });
    return;
  }
  if (process.platform === 'win32') {
    const { findInstall, resolveMainExe } = require('../lib/windows-registry');
    let entry;
    try { entry = findInstall(); } catch (err) {
      process.stderr.write(`Registry lookup failed: ${err.message}\n`);
      process.exit(1);
    }
    if (!entry) {
      process.stderr.write('Zen Tools is not installed (no entry in the Uninstall registry hives). Run `zen-tools install` first.\n');
      process.exit(1);
    }
    const exe = resolveMainExe(entry);
    if (!exe) {
      process.stderr.write(`Found install at ${entry.installLocation || '(unknown)'} but no Zen Tools exe is there. Try the Start Menu shortcut.\n`);
      process.exit(1);
    }
    const { spawn } = require('node:child_process');
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  process.stderr.write(`Cannot launch on ${process.platform}.\n`);
  process.exit(1);
}

function runUninstall({ quiet }) {
  if (process.platform === 'darwin') { require('../lib/uninstall-macos').uninstallMac({ quiet }); return; }
  if (process.platform === 'win32')  { require('../lib/uninstall-windows').uninstallWindows({ quiet }); return; }
  process.stderr.write(`Cannot uninstall on ${process.platform}.\n`);
  process.exit(1);
}

function parseFlags(argv) {
  const out = { positional: [], versionArg: null, launch: true, quiet: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; }
    else if (a === '--no-launch') { out.launch = false; }
    else if (a === '--quiet' || a === '-q') { out.quiet = true; }
    else if (a === '--version' || a === '-v') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { out.versionArg = next; i += 1; }
      else { out.version = true; }
    } else if (a.startsWith('--version=')) { out.versionArg = a.slice('--version='.length); }
    else if (a.startsWith('-')) { process.stderr.write(`Unknown flag: ${a}\n`); process.exit(2); }
    else { out.positional.push(a); }
  }
  return out;
}

function printUsage() {
  process.stdout.write(`@seg4lt/zen-tools — install Zen Tools from the command line

Usage:
  npx @seg4lt/zen-tools                   install latest + launch (default)
  zen-tools install [--version <tag>]     install a specific release tag
  zen-tools update                        install the latest release
  zen-tools launch                        open the installed app
  zen-tools uninstall                     remove the installed app

Options:
  --no-launch                             don't open the app after install
  --quiet, -q                             suppress progress output
  --version, -v                           print this wrapper's version
  --help, -h                              show this help

The wrapper version (${pkg.version}) is independent of the Zen Tools app version.
`);
}

main().catch((err) => { process.stderr.write(`\nzen-tools: ${err.message}\n`); process.exit(1); });
