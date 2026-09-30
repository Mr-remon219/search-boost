import { t, withTuiContext, tuiContext } from './i18n.mjs'
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
import { dshOperationProfiles } from '../agents/host-runtime.mjs'
import { dshDesktopStatus } from '../dsh-desktop.mjs'
import { getLayer, layerSelectOptions, setLayer, shouldPersistDefaultLayer } from '../layer-config.mjs'
import { autoAllowAgentIds, replaceableNativeIds } from '../native-search.mjs'
import { handleCancel, loadClack, tildify, getVersion, OK, FAIL, ARROW } from './ui.mjs'
import { runKeysWizard } from './keys-wizard.mjs'
import { runXAuthWizard } from './xauth-wizard.mjs'
import { importFromGrok, piAuthPath, readGrokAuth, readPiAuth } from '../search/x/xauth.js'

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
    message: t('Which agents should search-boost configure?', '为哪些 Agent 配置 search-boost？'),
    options: AGENT_IDS.map((id) => {
      const s = agentStatus(id)
      const flags = [
        s.detected ? t('(detected)', '（已检测到）') : t('(not found)', '（未找到）'),
        s.configured ? t('(configured)', '（已配置）') : '',
      ].filter(Boolean).join(' ')
      return { value: id, label: `${AGENTS[id].label} ${flags}`.trim() }
    }),
    initialValues: initial,
    required: false,
  })
  handleCancel(choice, clack)
  return /** @type {string[]} */ (choice)
}

/** A single DSH agent entry branches into independently managed host profiles. */
export async function runDshSurfaceStep(clack, targets, opts, { desktopStatus = dshDesktopStatus } = {}) {
  if (!targets.includes('dsh') || opts.yes || opts.profile || opts.dshSurface || !desktopStatus().detected) return opts.dshSurface ?? null
  clack.log.info(t('Desktop uses its bundled dsh command. Start it once, then fully quit it (including the tray) before changing plugins from this installer.', "Desktop 使用内置 dsh 命令。请先启动一次 Desktop，然后完全退出（包括托盘），再使用此安装器修改插件。"))
  const surface = await clack.select({
    message: t(`${opts.uninstall ? 'Remove' : 'Install'} search-boost for which DeepSeek Harness surface?`, `为哪个 DeepSeek Harness 环境${opts.uninstall ? '卸载' : '安装'} search-boost？`),
    options: [
      { value: 'desktop', label: t('Desktop — desktop profile', "Desktop — 桌面 profile") },
      { value: 'cli', label: t('CLI — command-line profiles', "CLI — 命令行 profiles") },
      { value: 'all', label: t('All — Desktop + CLI', "全部 — Desktop + CLI") },
    ],
    initialValue: opts.uninstall ? 'all' : 'desktop',
  })
  handleCancel(surface, clack)
  return surface
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean, skipKeys?: boolean }} opts
 */
async function runKeysStep(clack, opts) {
  if (opts.skipKeys || opts.yes) return
  if (opts.dryRun) {
    // Dry run: no prompt, no write. The wizard is skipped entirely.
    clack.log.info(t('dry-run: would offer API key setup (no credentials written)', "dry-run：将提供 API Key 配置（不写入凭据）。"))
    return
  }

  const configure = await clack.confirm({
    message: t('Configure API keys now? (tavily / brave / exa / anysearch; optional for free search)', "现在配置 API Keys？（tavily / brave / exa / anysearch；免费搜索无需配置）"),
    initialValue: !hasAnyKey(),
  })
  handleCancel(configure, clack)
  if (!configure) {
    clack.log.info(t('Skipped — free layer works without keys. Run `search-boost config keys` later.', "已跳过 — 免费搜索层无需 Key，稍后可运行 `search-boost config keys`。"))
    return
  }
  clack.log.info(t('Tip: a single keyed engine works on the api layer; additional engines can broaden retrieval.', "提示：api 层配置一个有 Key 的引擎即可使用；更多引擎有助于扩大检索范围。"))
  await runKeysWizard(clack, { dryRun: opts.dryRun })
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean, skipLayer?: boolean, dryRun?: boolean }} opts
 */
async function runLayerStep(clack, opts) {
  if (opts.skipLayer || opts.yes) {
    if (opts.dryRun) {
      clack.log.info(t('dry-run: would initialize the default search layer (nothing written)', "dry-run：将初始化默认搜索层（不写入配置）。"))
      return
    }
    if (shouldPersistDefaultLayer()) setLayer('free')
    return
  }

  const suggested = hasAnyKey() ? 'api' : 'free'
  const layer = await clack.select({
    message: t('Default search layer?', "默认搜索层？"),
    options: layerSelectOptions({ detailed: true, hasKeys: hasAnyKey() }),
    initialValue: suggested,
  })
  handleCancel(layer, clack)
  if (opts.dryRun) {
    clack.log.info(t(`dry-run: would set the search layer to ${layer} (nothing written)`, `dry-run：将搜索层设为 ${layer}（不写入配置）。`))
    return
  }
  setLayer(/** @type {'free'|'api'} */ (layer))
  if (layer === 'api' && !hasAnyKey()) {
    clack.log.warn(t('No API keys — api layer falls back to free engines until keys are set.', "未配置 API Keys — api 层暂时回退到免费引擎。"))
  }
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean, skipXAuth?: boolean, dryRun?: boolean }} opts
 */
async function runXAuthStep(clack, opts) {
  if (opts.skipXAuth || opts.yes) return

  const envKey = process.env.XAI_API_KEY?.startsWith('xai-')
  if (envKey || readPiAuth()?.key) return

  const grok = readGrokAuth()
  if (!grok) return

  if (opts.dryRun) {
    clack.log.info(t('dry-run: would offer to import the grok login (no credentials written)', "dry-run：将提供 Grok 登录导入（不写入凭据）。"))
    return
  }

  const ans = await clack.confirm({
    message: t('Import grok login for official x_search? (optional — improves X/Twitter search)', "导入 Grok 登录以启用官方 x_search？（可选，可改善 X/Twitter 搜索）"),
    initialValue: true,
  })
  handleCancel(ans, clack)
  if (!ans) {
    clack.log.info(t('Skipped — run `search-boost config x` later to enable official x_search.', "已跳过 — 稍后运行 `search-boost config x` 可启用官方 x_search。"))
    return
  }
  try {
    importFromGrok()
    clack.log.success(t(`Imported grok login → ${tildify(piAuthPath())}`, `已导入 Grok 登录 → ${tildify(piAuthPath())}`))
  } catch (err) {
    clack.log.warn(err instanceof Error ? err.message : String(err))
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
    message: t(`Auto-allow search-boost MCP tools in ${labels}? (skips permission prompts)`, `在 ${labels} 中自动授权 search-boost MCP 工具？（跳过权限提示）`),
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
    message: t(`Replace built-in web search in ${labels}?`, `替换 ${labels} 的内置网页搜索？`),
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
    message: t('Grok MCP scope?', "Grok MCP 安装作用域？"),
    options: [
      { value: 'user', label: t('user — ~/.grok/config.toml', "用户级 — ~/.grok/config.toml") },
      { value: 'project', label: t('project — .grok/config.toml in this directory', "项目级 — 当前目录的 .grok/config.toml") },
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
    message: t('Also inject Antigravity .agents/ into the current workspace?', "同时向当前工作区注入 Antigravity .agents/？"),
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
  const operations = targets.flatMap((id) => {
    if (id !== 'dsh') return [{ id }]
    try {
      const profiles = dshOperationProfiles(opts)
      return profiles.length ? profiles.map((profile) => ({ id, profile })) : [{ id, skip: true }]
    } catch (error) { return [{ id, error }] }
  })
  for (const operation of operations) {
    const { id, profile } = operation
    const agent = AGENTS[id]
    const label = `${agent?.label ?? id}${profile ? ` (${profile})` : ''}`
    const resultId = { id, ...(profile ? { profile } : {}) }
    try {
      if (!agent) throw new Error('unknown agent')
      if (operation.error) throw operation.error
      if (operation.skip) {
        results.push({ ...resultId, ok: true, files: [] })
        if (clack) clack.log.info(t(`${label}: no existing registrations`, `${label}：没有已有注册`))
        else console.log(`  ${OK} ${label}: no existing registrations`)
        continue
      }
      let dshStatus
      const agentOpts = profile ? { ...opts, profile, onDshStatus: status => { dshStatus = status } } : opts
      if (opts.uninstall) {
        await agent.uninstall(agentOpts)
        results.push({ ...resultId, ok: true, files: [] })
        if (clack) clack.log.success(t(`${label}: uninstalled`, `${label}：已卸载`))
        else console.log(`  ${OK} ${label}: uninstalled`)
      } else {
        const files = await agent.install(agentOpts)
        results.push({ ...resultId, ok: true, files, ...(dshStatus ? { dsh: dshStatus } : {}) })
        if (dshStatus) {
          const source = `${label}: v${dshStatus.version} → ${tildify(dshStatus.root)}`
          if (clack) clack.log.info(source)
          else console.log(`      ${ARROW} ${source}`)
          if (!dshStatus.enabled) {
            const message = t(`${label}: installed and verified, but disabled. Enable in the host plugin manager or repeat install with --enable-dsh-bundle.`, `${label}：已安装并验证，但处于禁用状态。可在宿主插件管理器启用，或加 --enable-dsh-bundle 重新安装。`)
            if (clack) clack.log.warn(message)
            else console.warn(`  ${message}`)
          }
        }
        for (const f of files) clack?.log.success(`${label}: ${tildify(f)}`)
        if (!clack) {
          console.log(`  ${OK} ${label}`)
          for (const f of files) console.log(`      ${ARROW} ${tildify(f)}`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ ...resultId, ok: false, error: msg })
      if (clack) clack.log.error(`${label}: ${msg}`)
      else console.error(`  ${FAIL} ${label}: ${msg}`)
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
 *   skipGrokPlugin?: boolean,
 *   profile?: string|null,
 *   dshSurface?: 'desktop'|'cli'|'all'|null,
 *   enableDshBundle?: boolean,
 *   clack?: import('@clack/prompts').ClackPrompter,
 * }} opts
 */
export async function runInstallerWithOptions(opts = {}) {
  // --yes is non-interactive even though setup reuses Clack's output chrome.
  // Do not read the saved/system TUI preference, or inherit a localized caller.
  if (opts.yes && tuiContext()?.language !== 'en') return withTuiContext(() => runInstallerWithOptions(opts), { language: 'en' })
  if (!opts.yes && !opts.clack && !tuiContext()) return withTuiContext(() => runInstallerWithOptions(opts))
  const clack = opts.clack ?? await loadClack()
  const ownChrome = !opts.clack
  const verb = opts.uninstall ? t('uninstall', '卸载') : t('install', '安装')
  if (ownChrome) clack.intro(`search-boost v${getVersion()} — ${verb}`)

  if (!opts.uninstall) {
    await runKeysStep(clack, opts)
    if (!opts.skipLayer) await runLayerStep(clack, opts)
    await runXAuthStep(clack, opts)
  }

  const rawTargets = await resolveTargets(clack, opts)
  if (rawTargets.length === 0) {
    const hint = t('Try `search-boost install --target all` or run `search-boost install` without -y/-t for interactive selection.', '可运行 `search-boost install --target all`，或不带 -y/-t 运行 `search-boost install` 以交互选择。')
    if (ownChrome) {
      clack.log.info(hint)
      clack.outro(t('No agents selected.', "未选择 Agent。"))
    } else {
      clack.log.warn(t('No agents selected.', "未选择 Agent。"))
      clack.log.info(hint)
    }
    return
  }

  const dshSurface = await runDshSurfaceStep(clack, rawTargets, opts)
  const { targets, mergeCursorCli } = normalizeTargets(rawTargets)
  const autoAllow = opts.uninstall ? false : await runAutoAllowStep(clack, rawTargets, opts)
  const replaceNative = opts.uninstall ? false : await runReplaceNativeStep(clack, rawTargets, opts)
  const scope = await runScopeStep(clack, rawTargets, opts)
  const workspace = opts.uninstall
    ? (opts.workspace ?? null)
    : await runWorkspaceStep(clack, rawTargets, opts)

  // Install-only must not initialize configuration before all choices are accepted.
  if (!opts.uninstall && opts.skipLayer) await runLayerStep(clack, opts)

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
    skipGrokPlugin: !!opts.skipGrokPlugin,
    profile: opts.profile ?? null,
    dshSurface,
    enableDshBundle: !!opts.enableDshBundle,
  }, clack)
  const failed = results.filter((r) => !r.ok)
  s.stop(opts.dryRun ? t('Dry run complete', "dry-run 完成") : t(`${verb} complete`, `${verb}完成`))

  if (!opts.uninstall && !opts.dryRun && failed.length === 0) {
    clack.note(t('Restart your agent(s) to load search-boost. Reopen Desktop if its plugins were changed.', "请重启 Agent 以加载 search-boost；如果修改了 Desktop 插件，请重新打开 Desktop。"), t('Next step', "下一步"))
  }
  if (failed.length) process.exitCode = 1
  if (ownChrome) {
    clack.outro(failed.length ? t(`Finished with ${failed.length} error(s).`, `完成，发生 ${failed.length} 个错误。`) : t('Done!', "完成！"))
  }
}

/** Full onboarding: keys → layer → agents */
export async function runWizard(opts = {}) {
  return runInstallerWithOptions({ ...opts, skipKeys: false })
}

/** Plain console install (for --yes / --target without clack). */
export async function runInstallPlain(opts) {
  if (!opts.uninstall) {
    console.log('Note: Skipped API keys and layer setup (non-interactive install).')
    console.log('  Run `search-boost setup` or `search-boost install` without -y/-t for full setup.\n')

    if (!opts.dryRun && shouldPersistDefaultLayer()) {
      setLayer('free')
    }
  }

  let rawTargets = opts.target ? parseTargetSpec(opts.target) : parseTargetSpec('auto')
  if (rawTargets.length === 0) {
    console.log(t('No agents selected.', "未选择 Agent。"))
    console.log('  Try: search-boost install --target all')
    console.log('  Or:  search-boost install   (interactive)')
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
    skipGrokPlugin: !!opts.skipGrokPlugin,
    profile: opts.profile ?? null,
    dshSurface: opts.dshSurface ?? null,
    enableDshBundle: !!opts.enableDshBundle,
  }, null)
  if (!opts.uninstall && !opts.dryRun && results.every((r) => r.ok)) {
    console.log('\nRestart your agent(s) to load search-boost. Reopen Desktop if its plugins were changed.')
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

export { runKeysWizard, printKeyStatus } from './keys-wizard.mjs'
export { runXAuthWizard, printXAuthStatus } from './xauth-wizard.mjs'
export { runJevWizard, printJevStatus } from './jev-wizard.mjs'
export { autoAllowTargets, replaceableNativeIds }
