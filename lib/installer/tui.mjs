import { AGENT_IDS, AGENTS } from '../agents/index.mjs'
import { getLayer, layerSelectOptions, setLayer } from '../layer-config.mjs'
import { applyNativeSearch, nativeSearchStatus, replaceableNativeIds } from '../native-search.mjs'
import { handleCancel, loadClack, getVersion, ARROW, OK, tildify } from './ui.mjs'
import { runKeysWizard } from './keys-wizard.mjs'
import { runInstallerWithOptions } from './index.mjs'
import { noteStatus } from './status.mjs'

/**
 * Unified TUI — one home menu for setup, install, config, and native search.
 * @param {{ dryRun?: boolean, scope?: 'user'|'project', workspace?: string|null }} [opts]
 */
export async function runTui(opts = {}) {
  const clack = await loadClack()
  clack.intro(`search-boost v${getVersion()}`)

  let running = true
  while (running) {
    const action = await clack.select({
      message: 'What do you want to do?',
      options: [
        { value: 'setup', label: 'Setup', hint: 'keys + layer + install agents' },
        { value: 'install', label: 'Install / update agents' },
        { value: 'uninstall', label: 'Uninstall' },
        { value: 'keys', label: 'API keys', hint: 'tavily / brave / exa' },
        { value: 'layer', label: 'Search layer', hint: 'free or api' },
        { value: 'search', label: 'Native web search', hint: 'replace built-in WebSearch' },
        { value: 'status', label: 'Status' },
        { value: 'print', label: 'Print MCP snippet' },
        { value: 'exit', label: 'Exit' },
      ],
    })
    handleCancel(action, clack)

    switch (action) {
      case 'setup':
        await runInstallerWithOptions({
          clack,
          skipKeys: false,
          dryRun: opts.dryRun,
          scope: opts.scope,
          workspace: opts.workspace,
        })
        break
      case 'install':
        clack.log.info('Note: Skipped API keys and layer setup (install-only).')
        clack.log.info('Run Setup from this menu, or `search-boost setup`, for keys + layer + agents.')
        await runInstallerWithOptions({
          clack,
          skipKeys: true,
          skipLayer: true,
          dryRun: opts.dryRun,
          scope: opts.scope,
          workspace: opts.workspace,
        })
        break
      case 'uninstall':
        await runInstallerWithOptions({
          clack,
          uninstall: true,
          dryRun: opts.dryRun,
          scope: opts.scope,
          workspace: opts.workspace,
        })
        break
      case 'keys':
        await runKeysWizard(clack, {})
        break
      case 'layer':
        await runLayerTui(clack)
        break
      case 'search':
        await runNativeSearchTui(clack, { dryRun: opts.dryRun })
        break
      case 'status':
        noteStatus(clack)
        break
      case 'print':
        await runPrintTui(clack)
        break
      case 'exit':
        running = false
        break
    }
  }

  clack.outro('Done.')
}

/** @param {import('@clack/prompts').ClackPrompter} clack */
async function runLayerTui(clack) {
  const layer = await clack.select({
    message: 'Default search layer?',
    options: layerSelectOptions(),
    initialValue: getLayer(),
  })
  handleCancel(layer, clack)
  setLayer(/** @type {'free'|'api'} */ (layer))
  clack.log.success(`Layer set to ${layer}`)
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ dryRun?: boolean }} opts
 */
export async function runNativeSearchTui(clack, opts = {}) {
  const rows = AGENT_IDS.map((id) => nativeSearchStatus(id))
  clack.note(
    rows.map((r) => {
      const agent = (AGENTS[r.id]?.label ?? r.id).padEnd(22)
      return `${agent} ${r.state.padEnd(9)} ${r.name}\n  ${r.note}`
    }).join('\n\n'),
    'Built-in web search',
  )

  const replaceable = replaceableNativeIds(AGENT_IDS)
  const choice = await clack.multiselect({
    message: 'Apply a config/deny switch for which agents?',
    options: replaceable.map((id) => {
      const r = nativeSearchStatus(id)
      return {
        value: id,
        label: `${AGENTS[id].label} — ${r.name} (${r.state})`,
      }
    }),
    initialValues: replaceable.filter((id) => nativeSearchStatus(id).state !== 'replaced'),
    required: false,
  })
  handleCancel(choice, clack)
  if (!choice.length) {
    clack.log.info('No config-level agents selected. Prompt-only agents are unchanged.')
    return
  }

  const replace = await clack.select({
    message: `For ${choice.map((id) => AGENTS[id].label).join(' + ')}:`,
    options: [
      { value: true, label: 'Replace — disable built-in web search' },
      { value: false, label: 'Keep — leave built-in web search on' },
    ],
    initialValue: true,
  })
  handleCancel(replace, clack)

  for (const id of choice) {
    const files = await applyNativeSearch(id, { replace: !!replace, dryRun: !!opts.dryRun })
    const verb = replace ? 'replaced' : 'kept'
    clack.log.success(`${AGENTS[id].label}: ${verb}${opts.dryRun ? ' (dry-run)' : ''} → ${files.join(', ') || 'no files'}`)
  }
}

/** @param {import('@clack/prompts').ClackPrompter} clack */
async function runPrintTui(clack) {
  const id = await clack.select({
    message: 'Print MCP snippet for which agent?',
    options: AGENT_IDS.map((agentId) => ({
      value: agentId,
      label: AGENTS[agentId].label,
    })),
  })
  handleCancel(id, clack)

  const autoAllow = await clack.confirm({
    message: 'Include auto-allow in the snippet?',
    initialValue: false,
  })
  handleCancel(autoAllow, clack)

  const replaceNative = await clack.confirm({
    message: 'Include native web-search replacement in the snippet?',
    initialValue: true,
  })
  handleCancel(replaceNative, clack)

  console.log(`\n${AGENTS[id].printConfig({ autoAllow, replaceNative })}\n`)
}

/** CLI: `search-boost config search` without TUI home. */
export async function runConfigSearch(opts = {}) {
  const clack = await loadClack()
  clack.intro(`search-boost v${getVersion()} — native web search`)
  await runNativeSearchTui(clack, opts)
  clack.outro('Done.')
}

/** Non-interactive native-search apply. */
export async function runConfigSearchPlain(opts) {
  const ids = opts.target
    ? replaceableNativeIds(opts.target.split(',').map((s) => s.trim()).filter(Boolean))
    : replaceableNativeIds()
  if (ids.length === 0) {
    console.log('No agents with a config-level web-search switch in the target list.')
    return
  }
  const replace = opts.replaceNative !== false
  console.log(`${replace ? 'Replace' : 'Keep'} built-in web search -> ${ids.join(', ')}${opts.dryRun ? ' (dry-run)' : ''}\n`)
  for (const id of ids) {
    const files = await applyNativeSearch(id, { replace, dryRun: !!opts.dryRun })
    console.log(`  ${OK} ${id}`)
    for (const f of files) console.log(`      ${ARROW} ${tildify(f)}`)
  }
}

