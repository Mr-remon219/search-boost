import { AGENT_IDS, AGENTS, agentStatus, parseTargetSpec } from '../agents/index.mjs'
import { getLayer, layerSelectOptions, setLayer } from '../layer-config.mjs'
import {
  runInstallerWithOptions,
  runInstallPlain,
  runKeysWizard,
} from '../installer/index.mjs'
import { handleCancel, loadClack } from '../installer/ui.mjs'
import { runConfigSearch, runConfigSearchPlain } from '../installer/tui.mjs'
import { nativeSearchStatus } from '../native-search.mjs'
import { help, installOpts, parseFlags } from './args.mjs'

/** @param {import('./args.mjs').CliFlags} flags @param {string} id */
export function printSnippet(id, flags) {
  const a = AGENTS[id]
  if (!a) throw new Error(`Unknown agent: ${id}`)
  console.log(a.printConfig({
    autoAllow: !!flags.autoAllow,
    replaceNative: flags.replaceNative !== false,
  }))
}

/** @param {boolean} uninstall */
export async function runInstall(uninstall, argv) {
  const flags = parseFlags(argv)
  if (flags.help) {
    help()
    return
  }
  if (flags.printConfig) {
    printSnippet(flags.printConfig, flags)
    return
  }

  const opts = installOpts(flags, uninstall)
  if (flags.yes || flags.target) {
    await runInstallPlain(opts)
    return
  }
  await runInstallerWithOptions(opts)
}

/** @param {string[]} args */
export async function runConfigKeys(args) {
  const flags = parseFlags(args)
  if (flags.help) {
    help()
    return
  }
  if (flags.yes || flags.show || Object.keys(flags.set).length || flags.unset.length) {
    await runKeysWizard(null, flags)
    return
  }
  const clack = await loadClack()
  await runKeysWizard(clack, flags)
}

/** @param {string[]} args */
export async function runConfigLayer(args) {
  const flags = parseFlags(args)
  if (flags.help) {
    help()
    return
  }
  if (flags.show || (flags.yes && !flags.layer)) {
    console.log(`Layer: ${getLayer()}`)
    console.log('File: ~/.dsh-search-boost-layer.json')
    return
  }
  if (flags.layer === 'free' || flags.layer === 'api') {
    setLayer(flags.layer)
    console.log(`Layer set to ${flags.layer}`)
    return
  }
  const clack = await loadClack()
  const layer = await clack.select({
    message: 'Default search layer?',
    options: layerSelectOptions(),
    initialValue: getLayer(),
  })
  handleCancel(layer, clack)
  setLayer(/** @type {'free'|'api'} */ (layer))
  clack.outro(`Layer set to ${layer}`)
}

/** @param {string[]} args */
export async function runConfigSearchCmd(args) {
  const flags = parseFlags(args)
  if (flags.help) {
    help()
    return
  }
  if (flags.show) {
    for (const id of AGENT_IDS) {
      const n = nativeSearchStatus(id)
      console.log(`${id}\t${n.state}\t${n.name}\t${n.kind}\t${n.note}`)
    }
    return
  }
  if (flags.yes || flags.target || flags.replaceNative !== null) {
    const targetIds = flags.target ? parseTargetSpec(flags.target) : undefined
    await runConfigSearchPlain({
      target: targetIds ? targetIds.join(',') : null,
      replaceNative: flags.replaceNative,
      dryRun: flags.dryRun,
    })
    return
  }
  await runConfigSearch({ dryRun: flags.dryRun })
}

export function printAgentsTsv() {
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    const n = nativeSearchStatus(id)
    console.log(`${id}\t${AGENTS[id].label}\t${s.detected ? 'detected' : '-'}\t${s.configured ? 'configured' : '-'}\t${n.state}`)
  }
}

/** @param {string|undefined} sub */
export async function runPlugin(sub) {
  if (sub === 'sync-grok') {
    await import('../../scripts/sync-grok-plugin.mjs')
    return
  }
  if (sub === 'build') {
    await import('../../scripts/build-plugin.mjs')
    return
  }
  throw new Error('Usage: search-boost plugin sync-grok|build')
}
