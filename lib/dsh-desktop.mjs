/** Read-only Desktop discovery. Never run npm DSH against Electron's profile. */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export const DESKTOP_PROFILE = 'desktop'
const PRODUCT = 'DeepSeek Harness'
export const DESKTOP_COMMAND_ENV = 'SEARCH_BOOST_DSH_DESKTOP_COMMAND'

function isFile(file) {
  try { return statSync(file).isFile() } catch { return false }
}

/** Native-platform candidates only: WSL must not write Linux paths into Windows profiles. */
export function desktopCommandCandidates({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  // An explicit override is authoritative, including a missing path. This also
  // lets the test bootstrap block absolute app discovery outside its sandbox.
  if (env[DESKTOP_COMMAND_ENV]) return [env[DESKTOP_COMMAND_ENV]]
  const paths = []
  if (platform === 'win32') {
    for (const base of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      paths.push(join(base, PRODUCT, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    }
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', join(home, 'Applications')]) {
      paths.push(join(base, `${PRODUCT}.app`, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
    }
  }
  // A registered macOS symlink or Windows PATH entry also finds moved installs.
  for (const base of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute)) {
    try {
      const file = realpathSync(join(base, platform === 'win32' ? 'dsh.cmd' : 'dsh'))
      if (/[\\/]resources[\\/]runtime[\\/]cli[\\/]bin[\\/]dsh(?:\.cmd)?$/i.test(file)) paths.push(file)
    } catch { /* not a Desktop launcher */ }
  }
  return [...new Set(paths)]
}

export function dshDesktopStatus({ home = homedir(), env = process.env, platform = process.platform, dshHome } = {}) {
  const root = dshHome ?? (env.DSH_HOME ? env.DSH_HOME.replace(/^~(?=$|[\\/])/, home) : join(home, '.dsh'))
  const profileDir = join(root, 'profiles', DESKTOP_PROFILE)
  const command = desktopCommandCandidates({ home, env, platform }).find((file) => isAbsolute(file) && isFile(file)) ?? null
  const initialized = isFile(join(profileDir, 'package.json'))
  return { detected: initialized || !!command, initialized, command, profileDir }
}

function sameFile(left, right) {
  try {
    if (realpathSync(left) === realpathSync(right)) return true
    const a = statSync(left, { bigint: true }), b = statSync(right, { bigint: true })
    // Hardlinked manifests and same-filesystem directory aliases can have
    // different realpaths. Zero inode values cannot establish an identity.
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
  } catch { return false }
}

/** Directory identity OR a shared manifest establishes Desktop ownership. */
export function isDesktopProfileDirectory(dir, desktopDir) {
  return resolve(dir) === resolve(desktopDir) || sameFile(dir, desktopDir)
    || sameFile(join(dir, 'package.json'), join(desktopDir, 'package.json'))
}

export function isDesktopProfile(profile, profiles) {
  return profile === DESKTOP_PROFILE || isDesktopProfileDirectory(join(profiles, profile), join(profiles, DESKTOP_PROFILE))
}

/** Preflight before any SearchBoost backup/write; the host still owns its locks. */
export function desktopLaunchCommand(args, { status = dshDesktopStatus(), dryRun = false } = {}) {
  if (!status.command) {
    throw new Error(`Desktop bundled dsh command not found. Install/repair Desktop, or set ${DESKTOP_COMMAND_ENV} to its absolute resources/runtime/cli/bin/dsh launcher. No npm DSH fallback is allowed.`)
  }
  if (!status.initialized) throw new Error('Start DeepSeek Harness Desktop once to initialize its desktop profile, then fully quit it and retry. No profile was created.')
  // Do not remove/take over an application lock, even when it appears stale.
  if (!dryRun && existsSync(join(status.profileDir, 'lock'))) {
    throw new Error(`Desktop profile lock is present at ${join(status.profileDir, 'lock')}. Fully quit DeepSeek Harness Desktop (including the tray), then retry; no profile files were changed.`)
  }
  return { command: status.command, args }
}
