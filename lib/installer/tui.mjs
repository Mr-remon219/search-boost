import { t, withTuiContext, tuiContext, readTuiSettings, saveTuiLayout, saveTuiLanguage, systemLanguage, layoutLabel, localizedClack, TuiCancelled, TuiExit, TuiHome, DEFAULT_TUI_LAYOUT, nativeStateLabel, nativeSearchNote } from './i18n.mjs'
import { runToolsWizard } from './tools-wizard.mjs'
import { AGENT_IDS, AGENTS } from '../agents/index.mjs'
import { getLayer, layerSelectOptions, setLayer } from '../layer-config.mjs'
import { applyNativeSearch, nativeSearchStatus, replaceableNativeIds } from '../native-search.mjs'
import { handleCancel, loadClack, getVersion, ARROW, OK, tildify } from './ui.mjs'
import { runEngineConfigTui } from './keys-wizard.mjs'
import { runCommunityWizard } from './community-wizard.mjs'
import { runJudgmentWizard } from './judgment-wizard.mjs'
import { runInstallerWithOptions } from './index.mjs'
import { runRefresh } from '../upgrade/index.mjs'
import { runRefreshTui } from './management.mjs'
import { noteStatus } from './status.mjs'

/**
 * Unified TUI — flat home by default, optional folder layout, persistent
 * submenus and per-invocation display language.
 * @param {{ dryRun?: boolean, scope?: 'user'|'project', workspace?: string|null }} [opts]
 */
export async function runTui(opts = {}, { clack: suppliedClack, refresh = runRefresh } = {}) {
  const clack = localizedClack(suppliedClack ?? await loadClack())
  let language, layout, settingsError
  try {
    ({ language, layout } = readTuiSettings())
  } catch (err) {
    language = systemLanguage()
    layout = DEFAULT_TUI_LAYOUT
    settingsError = err
  }
  return withTuiContext(async () => {
    clack.intro(`search-boost v${getVersion()}`)
    if (settingsError) {
      clack.log.warn(t('Could not read TUI settings; using the system language and the default flat layout.', '无法读取 TUI 设置，暂时使用系统语言与默认平铺布局。'))
      clack.log.warn(settingsError.message)
    }
    /** Current screen: the home menu or one submenu. */
    let screen = { kind: 'home' }
    /** Remembered entry per screen, so an operation returns to the entry it was started from. */
    const selection = {}
    let running = true
    while (running) {
      let operationStarted = false
      try {
        const layout = tuiContext().layout
        const screenKey = screenKeyOf(screen)
        const menu = screenMenu(screen, layout)
        const action = await clack.select({ ...menu, initialValue: selection[screenKey] })
        if (clack.isCancel(action)) {
          if (screen.kind === 'home') running = false
          else screen = screen.parent ?? { kind: 'home' }
          continue
        }
        // Reject invalid injected/stale actions rather than bypassing the menu hierarchy.
        if (!menu.options.some((option) => option.value === action)) throw new Error(`Unknown TUI action: ${String(action)}`)
        // Folder layout navigates through its categories; the flat home lists the entries themselves.
        if (screen.kind === 'home' && layout === 'folder' && action !== 'exit') {
          selection[screenKey] = action
          screen = { kind: 'section', section: action }
          continue
        }
        if (action === 'exit') {
          running = false
          continue
        }
        if (action === 'back') {
          screen = screen.parent ?? { kind: 'home' }
          continue
        }
        if (action === 'settings' || action === 'manage') {
          // Flat home: TUI settings is an entry with its own submenu.
          selection[screenKey] = action
          screen = { kind: 'section', section: action === 'manage' ? 'management' : 'settings', parent: screen }
          continue
        }
        operationStarted = true
        if (action === 'layout') {
          await runLayoutTui(clack, opts)
          // An accepted layout change applies immediately and returns to the new home menu.
          if (tuiContext().layout !== layout) {
            screen = { kind: 'home' }
            selection.home = 'settings'
            continue
          }
        } else if (action === 'language') {
          await runLanguageTui(clack, opts)
        } else {
          running = await runAction(action, clack, opts, refresh)
        }
        // A completed operation returns to its own menu with that entry still selected.
        selection[screenKey] = action
      } catch (err) {
        if (err instanceof TuiExit) running = false
        else if (err instanceof TuiHome) screen = { kind: 'home' }
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
  }, { language, layout, navigation: true })
}

const screenKeyOf = (screen) => (screen.kind === 'home' ? 'home' : `section:${screen.section}`)

/** Display-only: a broken store must not prevent navigation to other actions.
 * Actual configuration operations keep their strict read/write behavior.
 */
function currentLayerHint() {
  try {
    const layer = getLayer()
    return t(`current: ${layer}`, `当前：${layer}`)
  } catch {
    return t('configuration error', '配置错误')
  }
}

/**
 * One definition per entry: both layouts render these labels and dispatch them
 * through the same runAction/settings functions, so an entry cannot exist in one
 * layout only or drift in behaviour.
 */
function entryDefinitions() {
  return {
    setup: { label: () => t('Setup wizard', '首次配置向导'), hint: () => t('keys + layer + install agents', '从零配置并安装接入') },
    manage: { label: () => t('Manage agent integrations', '管理 Agent 接入'), hint: () => t('install / refresh / uninstall', '安装 / 刷新 / 卸载') },
    install: { label: () => t('Install integrations', '安装接入'), hint: () => t('configure selected hosts', '配置指定宿主') },
    refresh: { label: () => t('Refresh existing integrations', '刷新已有接入'), hint: () => t('current package; preserve user choices', '使用当前版本，保留用户选择') },
    search: { label: () => t('Native web search', '原生搜索替换'), hint: () => t('replace or keep built-in web search', '替换或保留宿主内置搜索') },
    print: { label: () => t('Print MCP snippet', '输出 MCP 配置片段'), hint: () => t('for manual configuration', '用于手动配置') },
    uninstall: { label: () => t('Uninstall agent integrations', '卸载 Agent 接入'), hint: () => t('remove search-boost from selected hosts', '移除指定宿主的接入') },
    layer: { label: () => t('Default search layer', '默认搜索层'), hint: currentLayerHint },
    tools: { label: () => t('Tool switches', '工具开关'), hint: () => t('enable or disable tool entries', '启用或停用工具入口') },
    keys: { label: () => t('Search engine configuration', '搜索引擎配置'), hint: () => t('API keys / Base URLs / engine routing', 'API Keys / Base URL / 引擎启停') },
    community: { label: () => t('Community configuration', 'Community 配置'), hint: () => t('platform switches / search sources / credentials', '平台启停 / 检索方式 / 凭据') },
    jev: { label: () => t('Judgment models (Jev / Laya)', '判断模型（Jev / Laya）'), hint: () => t('select service / switch saved profile · adaptive_search', '选择服务 / 切换已保存配置 · adaptive_search') },
    status: { label: () => t('Status', '查看当前状态'), hint: () => t('integrations, engines and credentials', '查看接入、引擎与凭据状态') },
    layout: { label: () => t('Menu layout', '菜单布局'), hint: () => layoutLabel(tuiContext().layout) },
    language: { label: () => t('Display language', '显示语言'), hint: () => (tuiContext().language === 'zh-CN' ? '简体中文' : 'English') },
    settings: { label: () => t('TUI settings', 'TUI 设置'), hint: () => t('menu layout / display language', '布局 / 显示语言') },
    exit: { label: () => t('Exit', '退出') },
    back: { label: () => t('Back to main menu', '返回主菜单') },
  }
}

/** Folder-layout categories; `settings` also defines the flat TUI-settings submenu. */
const SECTION_DEFS = [
  { value: 'integration', label: () => t('Installation & integrations', '安装与接入'), hint: () => t('setup / agents / native search / MCP', '首次配置 / Agent / 原生搜索 / MCP') },
  { value: 'search-tools', label: () => t('Search & tools', '搜索与工具'), hint: () => t('search layer / tool switches', '搜索层 / 工具开关') },
  { value: 'credentials', label: () => t('Services & credentials', '服务与凭据'), hint: () => t('engines / community / judgment', '搜索引擎 / 社区检索 / 判断模型') },
  { value: 'maintenance', label: () => t('Status', '状态'), hint: () => t('current configuration', '当前配置') },
  { value: 'settings', label: () => t('TUI settings', 'TUI 设置'), hint: () => t('menu layout / display language', '布局 / 显示语言') },
]

/**
 * Flat home order: onboarding and maintenance first, then configuration, then
 * low-frequency host operations, then TUI settings and Exit at the bottom.
 */
const FLAT_ORDER = ['setup', 'manage', 'status', 'keys', 'layer', 'tools', 'community', 'jev', 'search', 'print', 'settings', 'exit']

const SECTION_ORDER = {
  integration: ['setup', 'manage', 'search', 'print'],
  'search-tools': ['layer', 'tools'],
  credentials: ['keys', 'community', 'jev'],
  maintenance: ['status'],
  settings: ['layout', 'language'],
}

/** Home and section values for a layout: the folder sections and the flat home share one action set. */
function layoutEntries(layout) {
  return {
    home: layout === 'folder' ? [...SECTION_DEFS.map((section) => section.value), 'exit'] : [...FLAT_ORDER],
    sections: Object.fromEntries(Object.entries(SECTION_ORDER).map(([section, values]) => [section, [...values, 'back']])),
  }
}

function menuOptions(values) {
  const entries = entryDefinitions()
  const sections = new Map(SECTION_DEFS.map((section) => [section.value, section]))
  return values.map((value) => {
    const section = sections.get(value)
    if (section) return { value, label: section.label(), hint: section.hint() }
    const entry = entries[value]
    return { value, label: entry.label(), ...(entry.hint ? { hint: entry.hint() } : {}) }
  })
}

function screenMenu(screen, layout) {
  if (screen.kind === 'section') {
    if (screen.section === 'management') return { message: entryDefinitions().manage.label(), options: menuOptions(['install', 'refresh', 'uninstall', 'back']) }
    const section = SECTION_DEFS.find((item) => item.value === screen.section)
    return { message: section ? section.label() : screen.section, options: menuOptions(layoutEntries(layout).sections[screen.section]) }
  }
  if (layout === 'folder') return { message: t('What do you want to do?', '请选择功能分类'), options: menuOptions(layoutEntries('folder').home) }
  return { message: t('What do you want to do?', '请选择操作'), options: menuOptions(layoutEntries('flat').home) }
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

async function runAction(action, clack, opts, refresh) {
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
    case 'refresh':
      await runRefreshTui(clack, opts, refresh)
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
      await runEngineConfigTui(clack, { dryRun: opts.dryRun })
      break
    case 'tools':
      await runToolsWizard(clack, { dryRun: opts.dryRun })
      break
    case 'layer':
      await runLayerTui(clack, opts)
      break
    case 'community':
      await runCommunityWizard(clack, { dryRun: opts.dryRun })
      break
    case 'jev':
      await runJudgmentWizard(clack, { dryRun: opts.dryRun })
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
 * Menu layout: flat lists every entry on the home menu, folder keeps the
 * categories. An accepted choice applies immediately; Esc and dry-run do not
 * persist it.
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ dryRun?: boolean }} [opts]
 */
async function runLayoutTui(clack, opts = {}) {
  const current = tuiContext().layout
  const layout = await clack.select({
    message: t('Main menu layout', '菜单布局'),
    options: [
      { value: 'flat', label: t('Flat', '平铺'), hint: t('every function directly on the home menu', '所有功能直接列在主菜单') },
      { value: 'folder', label: t('Folder', '文件夹'), hint: t('pick a category first', '先选分类，再选功能') },
      { value: 'back', label: t('Back to TUI settings', '返回 TUI 设置') },
    ],
    initialValue: current,
  })
  handleCancel(layout, clack)
  if (layout === 'back' || layout === current) {
    clack.log.info(t('Menu layout unchanged.', '菜单布局未改变。'))
    return
  }
  if (opts.dryRun) {
    tuiContext().layout = layout
    clack.log.info(t('dry-run: layout preview only; preference was not saved.', 'dry-run：仅预览菜单布局，不保存设置。'))
    return
  }
  saveTuiLayout(layout)
  tuiContext().layout = layout
  clack.log.success(t('Menu layout saved.', '菜单布局已保存。'))
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

