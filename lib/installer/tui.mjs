import { t, withTuiContext, tuiContext, readTuiLanguage, saveTuiLanguage, systemLanguage, localizedClack, TuiCancelled, TuiExit, nativeStateLabel, nativeSearchNote } from './i18n.mjs'
import { runToolsWizard } from './tools-wizard.mjs'
import { AGENT_IDS, AGENTS } from '../agents/index.mjs'
import { getLayer, layerSelectOptions, setLayer } from '../layer-config.mjs'
import { applyNativeSearch, nativeSearchStatus, replaceableNativeIds } from '../native-search.mjs'
import { handleCancel, loadClack, getVersion, ARROW, OK, tildify } from './ui.mjs'
import { runKeysWizard } from './keys-wizard.mjs'
import { runXAuthWizard } from './xauth-wizard.mjs'
import { runJevWizard } from './jev-wizard.mjs'
import { runInstallerWithOptions } from './index.mjs'
import { runUpgrade } from '../upgrade/index.mjs'
import { noteStatus } from './status.mjs'

/**
 * Unified TUI — grouped home, persistent submenus and per-invocation display language.
 * @param {{ dryRun?: boolean, scope?: 'user'|'project', workspace?: string|null }} [opts]
 */
export async function runTui(opts = {}, { clack: suppliedClack, update = runUpgrade } = {}) {
  const clack = localizedClack(suppliedClack ?? await loadClack())
  let language
  let languageError
  try { language = readTuiLanguage() } catch (err) { language = systemLanguage(); languageError = err }
  return withTuiContext(async () => {
    clack.intro(`search-boost v${getVersion()}`)
    if (languageError) {
      clack.log.warn(t('Could not read TUI settings; using the system language.', '无法读取 TUI 设置，暂时使用系统语言。'))
      clack.log.warn(languageError.message)
    }
    let section = null
    let running = true
    while (running) {
      let operationStarted = false
      try {
        const menu = section ? sectionMenu(section) : homeMenu()
        const action = await clack.select(menu)
        if (clack.isCancel(action)) {
          if (section) section = null
          else running = false
          continue
        }
        // Reject invalid injected/stale actions rather than bypassing the menu hierarchy.
        if (!menu.options.some((option) => option.value === action)) throw new Error(`Unknown TUI action: ${String(action)}`)
        if (!section) {
          if (action === 'exit') running = false
          else section = action
        } else if (action === 'back') {
          section = null
        } else if (action === 'language') {
          operationStarted = true
          await runLanguageTui(clack, opts)
        } else {
          operationStarted = true
          running = await runAction(action, clack, opts, update)
        }
      } catch (err) {
        if (err instanceof TuiExit) running = false
        else if (!(err instanceof TuiCancelled)) {
          clack.log.error(t('Operation failed:', '操作失败：'))
          clack.log.error(err.message ?? String(err))
          process.exitCode = 1
          // A broken/closed menu input cannot be recovered by asking it again.
          if (!operationStarted) running = false
        }
      }
    }
    clack.outro(t('Done.', '已退出。'))
  }, { language, navigation: true })
}

function sections() {
  return [
    { value: 'integration', label: t('Installation & integrations', '安装与接入'), hint: t('setup / agents / native search / MCP', '首次配置 / Agent / 原生搜索 / MCP') },
    { value: 'search-tools', label: t('Search & tools', '搜索与工具'), hint: t('search layer / tool switches', '搜索层 / 工具开关') },
    { value: 'credentials', label: t('Services & credentials', '服务与凭据'), hint: t('engine keys / X / Jev', '引擎凭据 / X / Jev') },
    { value: 'maintenance', label: t('Update & status', '更新与状态'), hint: t('package updates / current configuration', '软件包更新 / 当前配置') },
    { value: 'settings', label: t('TUI settings', 'TUI 设置'), hint: t('display language', '显示语言') },
  ]
}

function homeMenu() {
  return {
    message: t('What do you want to do?', '请选择功能分类'),
    options: [...sections(), { value: 'exit', label: t('Exit', '退出') }],
  }
}

function sectionMenu(section) {
  const groups = {
    integration: [
      { value: 'setup', label: t('Setup', '首次配置向导'), hint: t('keys + layer + install agents', '凭据 + 搜索层 + 安装 Agent') },
      { value: 'install', label: t('Install / refresh agent integrations', '安装 / 刷新 Agent 接入'), hint: t('configure hosts without changing credentials', '配置宿主接入，不重复配置凭据') },
      { value: 'search', label: t('Native web search', '原生搜索替换'), hint: t('replace or keep built-in WebSearch', '替换或保留内置 WebSearch') },
      { value: 'print', label: t('Print MCP snippet', '输出 MCP 配置片段') },
      { value: 'uninstall', label: t('Uninstall agent integrations', '卸载 Agent 接入') },
    ],
    'search-tools': [
      { value: 'layer', label: t('Search layer', '默认搜索层'), hint: t('free or api', 'free 或 api') },
      { value: 'tools', label: t('Tool switches', '工具开关'), hint: t('enable / disable · MCP / Pi / DSH', '启用 / 停用 · MCP / Pi / DSH') },
    ],
    credentials: [
      { value: 'keys', label: t('API keys & Base URLs', '搜索引擎 API Keys 与 Base URLs'), hint: 'tavily / brave / exa / anysearch' },
      { value: 'x', label: t('X credentials', 'X 凭据'), hint: 'grok login / XAI_API_KEY' },
      { value: 'jev', label: t('Jev credentials (experimental)', 'Jev 配置（实验性）'), hint: t('TypeSafe / Vercel URL + API key', 'TypeSafe / Vercel URL + API Key') },
    ],
    maintenance: [
      { value: 'upgrade', label: t('Update', '更新 search-boost 与已安装接入'), hint: t('search-boost + all installed agents', 'search-boost + 所有已安装 Agent 接入') },
      { value: 'status', label: t('Status', '查看当前状态') },
    ],
    settings: [
      { value: 'language', label: t('Display language', '显示语言'), hint: tuiContext().language === 'zh-CN' ? '简体中文' : 'English' },
    ],
  }
  return {
    message: sections().find((item) => item.value === section).label,
    options: [...groups[section], { value: 'back', label: t('Back to main menu', '返回主菜单') }],
  }
}

async function runLanguageTui(clack, opts) {
  const language = await clack.select({
    message: t('TUI display language', 'TUI 显示语言'),
    options: [{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }],
    initialValue: tuiContext().language,
  })
  handleCancel(language, clack)
  if (opts.dryRun) {
    tuiContext().language = language
    clack.log.info(t('dry-run: language preview only; preference was not saved.', 'dry-run：仅预览显示语言，不保存设置。'))
    return
  }
  saveTuiLanguage(language)
  tuiContext().language = language
  clack.log.success(t('Display language saved.', '显示语言已保存。'))
}

async function runAction(action, clack, opts, update) {
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
      clack.log.info(t('Note: Skipped API keys, layer, and X credentials (install-only).', "提示：仅安装接入，跳过 API Keys、搜索层及 X 凭据配置。"))
      clack.log.info(t('Run Setup from this menu, or `search-boost setup`, for keys + layer + agents.', "如需配置凭据、搜索层及 Agent，请使用首次配置向导或 `search-boost setup`。"))
      await runInstallerWithOptions({
        clack,
        skipKeys: true,
        skipLayer: true,
        skipXAuth: true,
        dryRun: opts.dryRun,
        scope: opts.scope,
        workspace: opts.workspace,
      })
      break
    case 'upgrade':
      clack.log.info(t('Updates search-boost and all installed agents, including pi-search-boost and dsh-search-boost adapters. User configuration, credentials and permission choices are preserved.', "更新 search-boost 及所有已安装 Agent 接入，包括 pi-search-boost 和 dsh-search-boost 适配器。保留用户配置、凭据与权限选择。"))
      try {
        const result = await update({ dryRun: opts.dryRun, workspace: opts.workspace, log: (message) => clack.log.info(message) })
        if (!result.ok) process.exitCode = 1
        // A new package may have replaced modules on disk. Never continue the stale TUI.
        if (result.reloaded) return false
      } catch (err) {
        clack.log.error(err.message)
        process.exitCode = 1
        return false
      }
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
      await runKeysWizard(clack, { dryRun: opts.dryRun })
      break
    case 'tools':
      await runToolsWizard(clack, { dryRun: opts.dryRun })
      break
    case 'layer':
      await runLayerTui(clack, opts)
      break
    case 'x':
      await runXAuthWizard(clack, { dryRun: opts.dryRun })
      break
    case 'jev':
      await runJevWizard(clack, { dryRun: opts.dryRun })
      break
    case 'search':
      await runNativeSearchTui(clack, { dryRun: opts.dryRun })
      break
    case 'status': {
      await noteStatus(clack, { workspace: opts.workspace })
      break
    }
    case 'print':
      await runPrintTui(clack)
      break
  }
  return true
}

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ dryRun?: boolean }} [opts]
 */
async function runLayerTui(clack, opts = {}) {
  const layer = await clack.select({
    message: t('Default search layer?', "默认搜索层？"),
    options: layerSelectOptions(),
    initialValue: getLayer(),
  })
  handleCancel(layer, clack)
  if (opts.dryRun) {
    clack.log.info(t(`dry-run: would set the search layer to ${layer} (nothing written)`, `dry-run：将搜索层设为 ${layer}（不写入配置）。`))
    return
  }
  setLayer(/** @type {'free'|'api'} */ (layer))
  clack.log.success(t(`Layer set to ${layer}`, `搜索层已设为 ${layer}`))
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
      return `${agent} ${nativeStateLabel(r.state).padEnd(9)} ${r.name}\n  ${nativeSearchNote(r.id, r.note)}`
    }).join('\n\n'),
    t('Built-in web search', "内置网页搜索"),
  )

  const replaceable = replaceableNativeIds(AGENT_IDS)
  const choice = await clack.multiselect({
    message: t('Apply a config/deny switch for which agents?', "为哪些 Agent 设置原生搜索配置 / 禁用开关？"),
    options: replaceable.map((id) => {
      const r = nativeSearchStatus(id)
      return {
        value: id,
        label: `${AGENTS[id].label} — ${r.name} (${nativeStateLabel(r.state)})`,
      }
    }),
    initialValues: replaceable.filter((id) => nativeSearchStatus(id).state !== 'replaced'),
    required: false,
  })
  handleCancel(choice, clack)
  if (!choice.length) {
    clack.log.info(t('No config-level agents selected. Prompt-only agents are unchanged.', "未选择支持配置开关的 Agent；仅提示优先的 Agent 保持不变。"))
    return
  }

  const replace = await clack.select({
    message: t(`For ${choice.map((id) => AGENTS[id].label).join(' + ')}:`, `对 ${choice.map((id) => AGENTS[id].label).join(' + ')}：`),
    options: [
      { value: true, label: t('Replace — disable built-in web search', "替换 — 停用内置网页搜索") },
      { value: false, label: t('Keep — leave built-in web search on', "保留 — 继续启用内置网页搜索") },
    ],
    initialValue: true,
  })
  handleCancel(replace, clack)

  for (const id of choice) {
    const files = await applyNativeSearch(id, { replace: !!replace, dryRun: !!opts.dryRun })
    const verb = replace ? t('replaced', '已替换') : t('kept', '已保留')
    clack.log.success(`${AGENTS[id].label}: ${verb}${opts.dryRun ? t(' (dry-run)', '（dry-run）') : ''} → ${files.join(', ') || t('no files', '无文件变更')}`)
  }
}

/** @param {import('@clack/prompts').ClackPrompter} clack */
async function runPrintTui(clack) {
  const id = await clack.select({
    message: t('Print MCP snippet for which agent?', "为哪个 Agent 输出 MCP 配置片段？"),
    options: AGENT_IDS.map((agentId) => ({
      value: agentId,
      label: AGENTS[agentId].label,
    })),
  })
  handleCancel(id, clack)

  const autoAllow = await clack.confirm({
    message: t('Include auto-allow in the snippet?', "配置片段中包含自动授权？"),
    initialValue: false,
  })
  handleCancel(autoAllow, clack)

  const replaceNative = await clack.confirm({
    message: t('Include native web-search replacement in the snippet?', "配置片段中包含原生网页搜索替换？"),
    initialValue: true,
  })
  handleCancel(replaceNative, clack)

  console.log(`\n${AGENTS[id].printConfig({ autoAllow, replaceNative })}\n`)
}

/** CLI: `search-boost config search` without TUI home. */
export async function runConfigSearch(opts = {}) {
  if (!tuiContext()) return withTuiContext(() => runConfigSearch(opts))
  const clack = await loadClack()
  clack.intro(t(`search-boost v${getVersion()} — native web search`, `search-boost v${getVersion()} — 原生搜索替换`))
  await runNativeSearchTui(clack, opts)
  clack.outro(t('Done.', '完成。'))
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

