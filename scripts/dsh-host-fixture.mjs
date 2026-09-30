/** Hermetic carrier + official two-anchor resolver contract for subprocess tests.
 * This is a fake host, not a claim of live Electron/DSH validation.
 */
import { mkdirSync, writeFileSync, linkSync, copyFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function writeDshHostFixture(entry, { desktopHost = false, ownerArgument = false } = {}) {
  const base = dirname(entry)
  const write = (file, value) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  write(join(base, 'package.json'), { name: desktopHost ? '@deepseek-ai/dsh-desktop-host' : '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module' })
  if (desktopHost) {
    write(join(base, 'node_modules/@deepseek-ai/dsh/package.json'), { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module', exports: { './lib/bin.js': './lib/bin.js' } })
    write(join(base, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'export function runCli() {}\n')
  }
  const module = (name, source, exports = './index.mjs') => {
    const root = join(base, 'node_modules', '@deepseek-ai', name)
    write(join(root, 'package.json'), { name: '@deepseek-ai/' + name, type: 'module', exports })
    write(join(root, 'index.mjs'), source)
  }
  module('dsh-app-boot', `
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Contract from official app-boot/profile.ts: installation first, profile second;
// inspect manifest existence instead of assuming package.json is exported.
export function resolveBundleDir(bin, name, anchor, profile) {
  for (const from of [anchor, join(profile, 'package.json')]) {
    for (const path of createRequire(from).resolve.paths(name) ?? []) {
      const candidate = join(path, name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
  }
  throw Error('bundle not found');
}
export const DEFAULT_PROFILE_BUNDLES = [];
export const PROFILE_TEMPLATES = {};
export function initProfile(dir, bundles) {
  requireWrite(join(dir, 'package.json'), { dependencies: {}, dsh: { profile: { bundles } } });
}
function requireWrite(file, value) { writeFileSync(file, JSON.stringify(value)); }
export function loadOverlayPatches(bin, file) {
  if (readFileSync(file, 'utf8').trim() === '[') throw Error('fixture unparseable YAML patch');
  return [];
}
`)
  module('dsh-atomic-write', `
import { existsSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
export async function withFileLock(file, fn) {
  const fd = openSync(file + '.lock', 'wx');
  try { return await fn(); } finally { closeSync(fd); unlinkSync(file + '.lock'); }
}
export async function writeFileAtomic(file, value, options) {
  const temp = file + '.fixture-' + process.pid;
  try { writeFileSync(temp, value, options); renameSync(temp, file); } finally { if (existsSync(temp)) unlinkSync(temp); }
}
`)
  module('dsh-plugin-manager', `
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
export async function saveManifest(dir, value) { writeFileSync(join(dir, 'package.json'), JSON.stringify(value, null, 2) + '\\n'); }
// Invoke the fixture's synthetic package-manager body, not a real DSH main.
// The outer probe owns the actual write lock for this entire callback.
export async function runProfilePnpm(context, args, options) {
  if (!existsSync(join(context.dir, 'package.json.lock'))) throw Error('caller must hold official manifest lock');
  const prefix = process.argv.slice(2);
  if (prefix.at(-1) === '--version') prefix.pop();
  if (${JSON.stringify(ownerArgument)} && !prefix.length) prefix.push(context.profile === 'desktop' ? 'desktop' : 'cli');
  const result = spawnSync(process.execPath, [${JSON.stringify(entry)}, ...prefix, 'plugin', '--profile', context.profile, ...args], {
    env: { ...process.env, SEARCH_BOOST_DSH_PROBE_NONCE: '' }, encoding: 'utf8', timeout: 10000,
  });
  return { exitCode: result.status ?? 1 };
}
`, { './operations': './index.mjs' })
  return { anchor: join(desktopHost ? join(base, 'node_modules/@deepseek-ai/dsh') : base, 'package.json'), modules: join(base, 'node_modules') }
}

/** Fake application binary (Node, NOT Electron) and archive carrier path.
 * --import is passed explicitly, so the test can remove NODE_OPTIONS entirely.
 */
export function writeDesktopProbeFixture(command, entry) {
  const resources = resolve(dirname(command), '../../..')
  const executable = /\.cmd$/i.test(command)
    ? resolve(resources, '..', 'DeepSeek Harness.exe')
    : resolve(resources, '..', 'MacOS', 'DeepSeek Harness')
  mkdirSync(dirname(executable), { recursive: true })
  try { linkSync(process.execPath, executable) } catch { copyFileSync(process.execPath, executable) }
  const lib = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib')
  mkdirSync(dirname(lib), { recursive: true })
  symlinkSync(dirname(entry), lib, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(dirname(entry), 'cli.js'), 'throw Error("probe must stop before Desktop carrier main")\n')
  return { executable, entry: join(lib, 'cli.js') }
}
