/** Verify the next-boot bundle through the selected host's actual resolver. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { searchBoostHome } from './config-paths.mjs'
import { runCommand } from './upgrade/process.mjs'
import { desktopRuntimeProbeCommand } from './dsh-desktop.mjs'

export async function verifyDshRuntime(dir, launch, { root, version, enable = false, cleanupRemoved = false, installSpec, sourceRoot, profile, desktop = false, run = runCommand } = {}) {
  const index = launch.args.indexOf('plugin')
  if (index < 0) throw new Error('Cannot identify DSH launcher; runtime source was not verified.')
  const nonce = randomUUID()
  const probe = new URL('./dsh-runtime-probe.mjs', import.meta.url).href
  const nativeProbe = desktopRuntimeProbeCommand(launch.command, probe, { required: desktop })
  const env = { ...process.env,
    ...(nativeProbe ? { ELECTRON_RUN_AS_NODE: '1' } : { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${probe}`.trim() }),
    SEARCH_BOOST_DSH_PROBE_NONCE: nonce,
    SEARCH_BOOST_DSH_PROBE_PROFILE: dir,
    SEARCH_BOOST_DSH_PROBE_ROOT: cleanupRemoved ? '' : installSpec ? resolve(root) : realpathSync(root),
    SEARCH_BOOST_DSH_PROBE_INSTALL: installSpec ?? '',
    SEARCH_BOOST_DSH_PROBE_SOURCE: sourceRoot ?? '',
    SEARCH_BOOST_DSH_PROBE_PROFILE_NAME: profile ?? '',
    SEARCH_BOOST_DSH_PROBE_BACKUPS: resolve(searchBoostHome(), 'backups'),
    SEARCH_BOOST_DSH_PROBE_PNPM: nativeProbe ? JSON.stringify({ command: nativeProbe.command,
      args: ['--expose-internals', join(resolve(dirname(launch.command), '../..'), 'pnpm', 'bin', 'pnpm.mjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: nativeProbe.command,
        PATH: `${join(resolve(dirname(launch.command), '../..'), 'bin')}${delimiter}${process.env.PATH ?? ''}` } }) : '',
    SEARCH_BOOST_DSH_PROBE_CLEANUP: cleanupRemoved ? '1' : '0',
    SEARCH_BOOST_DSH_PROBE_VERSION: version,
    SEARCH_BOOST_DSH_PROBE_ENABLE: enable ? '1' : '0',
    SEARCH_BOOST_DSH_PROBE_DESKTOP: desktop ? '1' : '0',
  }
  let response
  try {
    // Retain npm exec's package/PATH context; --version is harmless if an
    // unsupported wrapper strips NODE_OPTIONS. A missing probe is NOT success.
    response = await run(nativeProbe?.command ?? launch.command,
      nativeProbe?.args ?? [...launch.args.slice(0, index), '--version'], { env, timeoutMs: installSpec ? 900_000 : 30_000 })
  } catch {
    if (installSpec) throw new Error(`DSH installation was interrupted; recovery may be pending. Inspect ${join(dir, '.search-boost-install-pending.json')} and private backups before retrying or restarting the host. Installation was not verified.`)
    throw new Error('Cannot inspect the owning DSH runtime; installation was not verified.')
  }
  const prefix = `SEARCH_BOOST_DSH_RUNTIME:${nonce}:`
  const lines = String(response.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith(prefix))
  let payload
  try { if (lines.length === 1) payload = JSON.parse(lines[0].slice(prefix.length)) } catch { /* fail closed */ }
  if (installSpec && response.code === 124) throw new Error(`DSH installation timed out; recovery may be pending. Inspect ${join(dir, '.search-boost-install-pending.json')} and private backups before retrying or restarting the host. Installation was not verified.`)
  if (payload?.error === 'install-recovery-pending') throw new Error(`DSH has an interrupted installation or earlier host package run pending recovery. Inspect ${join(dir, '.search-boost-install-pending.json')} and ${join(dir, '.plugin-manager/run.json')}. No new package operation was started; stop earlier package processes before recovering.`)
  if (payload?.error === 'install-backup-failed') throw new Error('DSH could not create its private profile backup; no profile file or package was changed. Check free space, permissions and file ownership; installation was not verified.')
  if (payload?.error === 'install-failed-restored') {
    const reason = payload.failure === 'source' ? 'DSH runtime bundle source/version mismatch'
      : payload.failure === 'payload' ? 'DSH installed payload differs'
      : payload.failure === 'timeout' ? 'DSH package operation timed out'
      : payload.failure === 'activation' ? 'DSH explicit activation failed' : 'DSH install/source verification failed'
    throw new Error(`${reason}${Number.isInteger(payload.exitCode) && payload.exitCode !== 0 ? ` (exit ${payload.exitCode})` : ''}; the previous profile files and node_modules were restored; installation was not verified.`)
  }
  if (payload?.error === 'install-rollback-incomplete') throw new Error(`DSH installation failed and rollback is incomplete; recover from the private backup before retrying: ${join(searchBoostHome(), 'backups')}. Installation was not verified.`)
  if (response.code !== 0 || !payload || payload.error || (!cleanupRemoved && (typeof payload.root !== 'string' || !isAbsolute(payload.root)))
    || typeof payload.installAnchor !== 'string' || !isAbsolute(payload.installAnchor)) {
    throw new Error('DSH runtime resolver/enable verification unavailable. Use a supported official DSH launcher; check host locks before enabling. Installation was not verified.')
  }
  if (nativeProbe && (typeof payload.execPath !== 'string' || !isAbsolute(payload.execPath)
    || realpathSync(payload.execPath) !== realpathSync(nativeProbe.command) || payload.entry !== nativeProbe.args.at(-2))) {
    throw new Error('Desktop probe did not use the owning runtime/carrier; installation was not verified.')
  }
  if (cleanupRemoved) {
    if (payload.removed !== true) throw new Error('DSH stale bundle cleanup was not verified.')
    return { removed: true }
  }
  const expectedRoot = installSpec ? realpathSync(root) : env.SEARCH_BOOST_DSH_PROBE_ROOT
  if (payload.root !== expectedRoot || payload.name !== 'search-boost' || payload.version !== version
    || payload.patch !== './adapters/dsh/cordis.patch.yml' || payload.files !== true) {
    const actualVersion = typeof payload.version === 'string' && payload.version.length <= 128
      && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(payload.version) ? payload.version : '[invalid version]'
    throw new Error(`DSH runtime bundle source/version mismatch: expected ${JSON.stringify(env.SEARCH_BOOST_DSH_PROBE_ROOT)} @ ${version}, resolved ${JSON.stringify(payload.root)} @ ${actualVersion}. A host-side package may shadow the profile. Remove/update that conflicting package explicitly, then retry; installation was not verified.`)
  }
  return { root: payload.root, version: payload.version, installAnchor: payload.installAnchor, hostVersion: payload.hostVersion,
    ...(installSpec ? { enabled: payload.enabled === true } : {}) }
}
