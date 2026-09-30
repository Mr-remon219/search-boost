/** Verify the next-boot bundle through the selected host's actual resolver. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { runCommand } from './upgrade/process.mjs'
import { desktopRuntimeProbeCommand } from './dsh-desktop.mjs'

export async function verifyDshRuntime(dir, launch, { root, version, enable = false, desktop = false, run = runCommand } = {}) {
  const index = launch.args.indexOf('plugin')
  if (index < 0) throw new Error('Cannot identify DSH launcher; runtime source was not verified.')
  const nonce = randomUUID()
  const probe = new URL('./dsh-runtime-probe.mjs', import.meta.url).href
  const nativeProbe = desktopRuntimeProbeCommand(launch.command, probe, { required: desktop })
  const env = { ...process.env,
    ...(nativeProbe ? { ELECTRON_RUN_AS_NODE: '1' } : { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${probe}`.trim() }),
    SEARCH_BOOST_DSH_PROBE_NONCE: nonce,
    SEARCH_BOOST_DSH_PROBE_PROFILE: dir,
    SEARCH_BOOST_DSH_PROBE_ROOT: realpathSync(root),
    SEARCH_BOOST_DSH_PROBE_VERSION: version,
    SEARCH_BOOST_DSH_PROBE_ENABLE: enable ? '1' : '0',
    SEARCH_BOOST_DSH_PROBE_DESKTOP: desktop ? '1' : '0',
  }
  let response
  try {
    // Retain npm exec's package/PATH context; --version is harmless if an
    // unsupported wrapper strips NODE_OPTIONS. A missing probe is NOT success.
    response = await run(nativeProbe?.command ?? launch.command,
      nativeProbe?.args ?? [...launch.args.slice(0, index), '--version'], { env, timeoutMs: 30_000 })
  } catch { throw new Error('Cannot inspect the owning DSH runtime; installation was not verified.') }
  const prefix = `SEARCH_BOOST_DSH_RUNTIME:${nonce}:`
  const lines = String(response.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith(prefix))
  let payload
  try { if (lines.length === 1) payload = JSON.parse(lines[0].slice(prefix.length)) } catch { /* fail closed */ }
  if (response.code !== 0 || !payload || payload.error || typeof payload.root !== 'string' || !isAbsolute(payload.root)
    || typeof payload.installAnchor !== 'string' || !isAbsolute(payload.installAnchor)) {
    throw new Error('DSH runtime resolver/enable verification unavailable. Use a supported official DSH launcher; check host locks before enabling. Installation was not verified.')
  }
  if (nativeProbe && (typeof payload.execPath !== 'string' || !isAbsolute(payload.execPath)
    || realpathSync(payload.execPath) !== realpathSync(nativeProbe.command) || payload.entry !== nativeProbe.args.at(-2))) {
    throw new Error('Desktop probe did not use the owning runtime/carrier; installation was not verified.')
  }
  if (payload.root !== env.SEARCH_BOOST_DSH_PROBE_ROOT || payload.name !== 'search-boost' || payload.version !== version
    || payload.patch !== './adapters/dsh/cordis.patch.yml' || payload.files !== true) {
    const actualVersion = typeof payload.version === 'string' && payload.version.length <= 128
      && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(payload.version) ? payload.version : '[invalid version]'
    throw new Error(`DSH runtime bundle source/version mismatch: expected ${JSON.stringify(env.SEARCH_BOOST_DSH_PROBE_ROOT)} @ ${version}, resolved ${JSON.stringify(payload.root)} @ ${actualVersion}. A host-side package may shadow the profile. Remove/update that conflicting package explicitly, then retry; installation was not verified.`)
  }
  return { root: payload.root, version: payload.version, installAnchor: payload.installAnchor, hostVersion: payload.hostVersion }
}
