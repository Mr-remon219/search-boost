import {
  AGENT_IDS,
  AGENTS,
  agentStatus,
  normalizeTargets,
  parseTargetSpec,
} from '../agents/index.mjs'
import { hasAnyKey } from '../keys.mjs'
import { getLayer, setLayer } from '../layer-config.mjs'
import { handleCancel, loadClack, tildify, getVersion } from './ui.mjs'
import { runKeysWizard } from './keys-wizard.mjs'

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ target?: string, yes?: boolean }} opts
 */
async function resolveTargets(clack, opts) {
  if (opts.target !== undefined && opts.target !== null) {
    return parseTargetSpec(opts.target)
  }
  if (opts.yes) return parseTargetSpec('auto')

  const detected = AGENT_IDS.filter((id) => agentStatus(id).detected)
  const initial = detected.length > 0 ? detected : ['cursor']

  const choice = await clack.multiselect({
    message: 'Which agents should search-boost configure?',
    options: AGENT_IDS.map((id) => {
      const s = agentStatus(id)
      const flags = [
        s.detected ? '(detected)' : '(not found)',
        s.configured ? '(configured)' : '',
      ].filter(Boolean).join(' ')
      return { value: id, label: `${AGENTS[id].label} ${flags}`.trim() }
    }),
    initialValues: initial,
    required: false,
  })
  handleCancel(choice, clack)
  return /** @type {string[]} */ (choice)
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean, skipKeys?: boolean }} opts
 */
async function runKeysStep(clack, opts) {
  if (opts.skipKeys || opts.yes) return

  const configure = await clack.confirm({
    message: 'Configure API keys now? (tavily / brave / exa — optional for free layer)',
    initialValue: !hasAnyKey(),
  })
  handleCancel(configure, clack)
  if (!configure) {
    clack.log.info('Skipped — free layer works without keys. Run `search-boost config keys` later.')
    return
  }
  await runKeysWizard(clack, {})
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean }} opts
 */
async function runLayerStep(clack, opts) {
  if (opts.yes) {
    if (!hasAnyKey()) setLayer('free')
    return
  }

  const suggested = hasAnyKey() ? 'api' : 'free'
  const layer = await clack.select({
    message: 'Default search layer?',
    options: [
      { value: 'free', label: 'free — keyless engines (bing, ddg, exa-free, agy)' },
      { value: 'api', label: 'api — full pool incl. keyed tavily/brave/exa', hint: hasAnyKey() ? 'keys detected' : 'needs keys' },
    ],
    initialValue: suggested,
  })
  handleCancel(layer, clack)
  setLayer(/** @type {'free'|'api'} */ (layer))
  if (layer === 'api' && !hasAnyKey()) {
    clack.log.warn('No API keys — api layer falls back to free engines until keys are set.')
  }
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {string[]} rawTargets
 * @param {{ dryRun?: boolean, autoAllow?: boolean, yes?: boolean }} opts
 */
async function runAutoAllowStep(clack, rawTargets, opts) {
  const needs = rawTargets.filter((id) => id === 'claude' || id === 'grok')
  if (needs.length === 0) return false
  if (opts.autoAllow === true) return true
  if (opts.yes) return false

  const labels = needs.map((id) => AGENTS[id]?.label ?? id).join(' + ')
  const ans = await clack.confirm({
    message: `Auto-allow search-boost tools in ${labels}? (skips permission prompts)`,
    initialValue: true,
  })
  handleCancel(ans, clack)
  return ans
}

/**
 * @param {string[]} targets
 * @param {{ dryRun?: boolean, autoAllow?: boolean, mergeCursorCli?: boolean, uninstall?: boolean, scope?: 'user'|'project' }} opts
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 */
export async function executeAgentOps(targets, opts, clack = null) {
  const results = []
  for (const id of targets) {
    const agent = AGENTS[id]
    if (!agent) {
      results.push({ id, ok: false, error: 'unknown agent' })
      continue
    }
    try {
      if (opts.uninstall) {
        await agent.uninstall(opts)
        results.push({ id, ok: true, files: [] })
        clack?.log.success(`${AGENTS[id].label}: uninstalled`)
      } else {
        const files = await agent.install(opts)
        results.push({ id, ok: true, files })
        for (const f of files) {
          clack?.log.success(`${AGENTS[id].label}: ${tildify(f)}`)
        }
        if (!clack) {
          console.log(`  ✓ ${id}`)
          for (const f of files) console.log(`      → ${f}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ id, ok: false, error: msg })
      if (clack) clack.log.error(`${AGENTS[id].label}: ${msg}`)
      else console.error(`  ✗ ${id}: ${msg}`)
    }
  }
  return results
}

/**
 * @param {{
 *   target?: string | null,
 *   yes?: boolean,
 *   dryRun?: boolean,
 *   autoAllow?: boolean,
 *   skipKeys?: boolean,
 *   uninstall?: boolean,
 *   scope?: 'user'|'project',
 * }} opts
 */
export async function runInstallerWithOptions(opts = {}) {
  const clack = await loadClack()
  const verb = opts.uninstall ? 'uninstall' : 'install'
  clack.intro(`search-boost v${getVersion()} — ${verb}`)

  if (!opts.uninstall) {
    await runKeysStep(clack, opts)
    await runLayerStep(clack, opts)
  }

  const rawTargets = await resolveTargets(clack, opts)
  if (rawTargets.length === 0) {
    clack.outro('No agents selected.')
    return
  }

  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const autoAllow = opts.uninstall ? false : await runAutoAllowStep(clack, rawTargets, opts)

  const s = clack.spinner()
  s.start(`${verb}…`)
  await executeAgentOps(targets, {
    dryRun: !!opts.dryRun,
    autoAllow,
    mergeCursorCli,
    uninstall: !!opts.uninstall,
    scope: opts.scope,
  }, clack)
  s.stop(opts.dryRun ? 'Dry run complete' : `${verb} complete`)

  if (!opts.uninstall && !opts.dryRun) {
    clack.note('Restart your agent(s) to load the search-boost MCP server.', 'Next step')
  }
  clack.outro('Done!')
}

/** Full onboarding: keys → layer → agents */
export async function runWizard(opts = {}) {
  return runInstallerWithOptions({ ...opts, skipKeys: false })
}

/** Plain console install (for --yes without clack). */
export async function runInstallPlain(opts) {
  let rawTargets = opts.target ? parseTargetSpec(opts.target) : parseTargetSpec('auto')
  if (rawTargets.length === 0) {
    console.log('No agents selected.')
    return
  }
  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const mergeNote = mergeCursorCli ? ' (cursor + cursor-cli merged)' : ''
  console.log(
    `${opts.uninstall ? 'Uninstall' : 'Install'} search-boost → ${rawTargets.join(', ')}${mergeNote}${opts.dryRun ? ' (dry-run)' : ''}\n`,
  )
  await executeAgentOps(targets, {
    dryRun: !!opts.dryRun,
    autoAllow: !!opts.autoAllow,
    mergeCursorCli,
    uninstall: !!opts.uninstall,
    scope: opts.scope,
  }, null)
  if (!opts.uninstall && !opts.dryRun) {
    console.log('\nRestart your agent(s) to load the search-boost MCP server.')
  }
}

export { runKeysWizard, printKeyStatus } from './keys-wizard.mjs'
