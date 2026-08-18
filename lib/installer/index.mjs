import { resolve } from 'node:path'
import { cwd } from 'node:process'
import {
  AGENT_IDS,
  AGENTS,
  agentStatus,
  normalizeTargets,
  parseTargetSpec,
} from '../agents/index.mjs'
import { hasAnyKey } from '../keys.mjs'
import { getLayer, layerSelectOptions, setLayer } from '../layer-config.mjs'
import { autoAllowAgentIds, replaceableNativeIds } from '../native-search.mjs'
import { handleCancel, loadClack, tildify, getVersion, OK, FAIL, ARROW } from './ui.mjs'
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
    options: layerSelectOptions({ detailed: true, hasKeys: hasAnyKey() }),
    initialValue: suggested,
  })
  handleCancel(layer, clack)
  setLayer(/** @type {'free'|'api'} */ (layer))
  if (layer === 'api' && !hasAnyKey()) {
    clack.log.warn('No API keys — api layer falls back to free engines until keys are set.')
  }
}

/** @param {string[]} rawTargets */
function autoAllowTargets(rawTargets) {
  const allow = new Set(autoAllowAgentIds())
  return rawTargets.filter((id) => allow.has(id))
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {string[]} rawTargets
 * @param {{ dryRun?: boolean, autoAllow?: boolean, yes?: boolean }} opts
 */
async function runAutoAllowStep(clack, rawTargets, opts) {
  const needs = autoAllowTargets(rawTargets)
  if (needs.length === 0) return false
  if (opts.autoAllow === true) return true
  if (opts.yes) return true

  const labels = needs.map((id) => AGENTS[id]?.label ?? id).join(' + ')
  const ans = await clack.confirm({
    message: `Auto-allow search-boost MCP tools in ${labels}? (skips permission prompts)`,
    initialValue: true,
  })
  handleCancel(ans, clack)
  return ans
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {string[]} rawTargets
 * @param {{ replaceNative?: boolean, yes?: boolean }} opts
 */
async function runReplaceNativeStep(clack, rawTargets, opts) {
  const needs = replaceableNativeIds(rawTargets)
  if (needs.length === 0) return false
  if (opts.replaceNative === true) return true
  if (opts.replaceNative === false) return false
  if (opts.yes) return true

  const labels = needs.map((id) => {
    const name = id === 'codex' ? 'web_search' : 'WebSearch'
    return `${AGENTS[id]?.label ?? id} (${name})`
  }).join(' + ')
  const ans = await clack.confirm({
    message: `Replace built-in web search in ${labels}?`,
    initialValue: true,
  })
  handleCancel(ans, clack)
  return ans
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {string[]} rawTargets
 * @param {{ scope?: 'user'|'project', yes?: boolean }} opts
 */
async function runScopeStep(clack, rawTargets, opts) {
  if (!rawTargets.includes('grok')) return opts.scope ?? 'user'
  if (opts.yes) return opts.scope ?? 'user'
  const scope = await clack.select({
    message: 'Grok MCP scope?',
    options: [
      { value: 'user', label: 'user — ~/.grok/config.toml' },
      { value: 'project', label: 'project — .grok/config.toml in this directory' },
    ],
    initialValue: opts.scope ?? 'user',
  })
  handleCancel(scope, clack)
  return /** @type {'user'|'project'} */ (scope)
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {string[]} rawTargets
 * @param {{ workspace?: string|null, yes?: boolean }} opts
 */
async function runWorkspaceStep(clack, rawTargets, opts) {
  if (!rawTargets.includes('antigravity')) return opts.workspace ?? null
  if (opts.workspace) return opts.workspace
  if (opts.yes) return null
  const yes = await clack.confirm({
    message: 'Also inject Antigravity .agents/ into the current workspace?',
    initialValue: false,
  })
  handleCancel(yes, clack)
  return yes ? resolve(cwd()) : null
}

/**
 * @param {string[]} targets
 * @param {import('../agents/types.mjs').InstallOpts & { uninstall?: boolean }} opts
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
          console.log(`  ${OK} ${id}`)
          for (const f of files) console.log(`      ${ARROW} ${f}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ id, ok: false, error: msg })
      if (clack) clack.log.error(`${AGENTS[id].label}: ${msg}`)
      else console.error(`  ${FAIL} ${id}: ${msg}`)
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
 *   replaceNative?: boolean,
 *   skipKeys?: boolean,
 *   uninstall?: boolean,
 *   scope?: 'user'|'project',
 *   workspace?: string|null,
 *   clack?: import('@clack/prompts').ClackPrompter,
 * }} opts
 */
export async function runInstallerWithOptions(opts = {}) {
  const clack = opts.clack ?? await loadClack()
  const ownChrome = !opts.clack
  const verb = opts.uninstall ? 'uninstall' : 'install'
  if (ownChrome) clack.intro(`search-boost v${getVersion()} — ${verb}`)

  if (!opts.uninstall) {
    await runKeysStep(clack, opts)
    await runLayerStep(clack, opts)
  }

  const rawTargets = await resolveTargets(clack, opts)
  if (rawTargets.length === 0) {
    if (ownChrome) clack.outro('No agents selected.')
    else clack.log.warn('No agents selected.')
    return
  }

  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const autoAllow = opts.uninstall ? false : await runAutoAllowStep(clack, rawTargets, opts)
  const replaceNative = opts.uninstall ? false : await runReplaceNativeStep(clack, rawTargets, opts)
  const scope = opts.uninstall
    ? (opts.scope ?? 'user')
    : await runScopeStep(clack, rawTargets, opts)
  const workspace = opts.uninstall
    ? (opts.workspace ?? null)
    : await runWorkspaceStep(clack, rawTargets, opts)

  const s = clack.spinner()
  s.start(`${verb}…`)
  const results = await executeAgentOps(targets, {
    dryRun: !!opts.dryRun,
    autoAllow,
    replaceNative,
    mergeCursorCli,
    uninstall: !!opts.uninstall,
    scope,
    workspace,
  }, clack)
  const failed = results.filter((r) => !r.ok)
  s.stop(opts.dryRun ? 'Dry run complete' : `${verb} complete`)

  if (!opts.uninstall && !opts.dryRun && failed.length === 0) {
    clack.note('Restart your agent(s) to load the search-boost MCP server.', 'Next step')
  }
  if (ownChrome) {
    clack.outro(failed.length ? `Finished with ${failed.length} error(s).` : 'Done!')
    if (failed.length) process.exitCode = 1
  }
}

/** Full onboarding: keys → layer → agents */
export async function runWizard(opts = {}) {
  return runInstallerWithOptions({ ...opts, skipKeys: false })
}

/** Plain console install (for --yes / --target without clack). */
export async function runInstallPlain(opts) {
  if (!opts.uninstall && !opts.dryRun && opts.yes && !hasAnyKey()) {
    setLayer('free')
  }

  let rawTargets = opts.target ? parseTargetSpec(opts.target) : parseTargetSpec('auto')
  if (rawTargets.length === 0) {
    console.log('No agents selected.')
    return
  }
  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const mergeNote = mergeCursorCli ? ' (cursor + cursor-cli merged)' : ''
  const autoAllow = !!opts.autoAllow || (!!opts.yes && autoAllowTargets(rawTargets).length > 0)
  const replaceNative = opts.replaceNative !== false
  const extras = [
    opts.dryRun ? 'dry-run' : '',
    opts.workspace ? `workspace=${opts.workspace}` : '',
    replaceNative ? 'replace-native' : 'keep-native',
  ].filter(Boolean)
  console.log(
    `${opts.uninstall ? 'Uninstall' : 'Install'} search-boost -> ${rawTargets.join(', ')}${mergeNote}${extras.length ? ` (${extras.join(', ')})` : ''}\n`,
  )
  const results = await executeAgentOps(targets, {
    dryRun: !!opts.dryRun,
    autoAllow,
    replaceNative: opts.uninstall ? false : replaceNative,
    mergeCursorCli,
    uninstall: !!opts.uninstall,
    scope: opts.scope,
    workspace: opts.workspace ?? null,
  }, null)
  if (!opts.uninstall && !opts.dryRun) {
    console.log('\nRestart your agent(s) to load the search-boost MCP server.')
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

export { runKeysWizard, printKeyStatus } from './keys-wizard.mjs'
export { autoAllowTargets, replaceableNativeIds }
