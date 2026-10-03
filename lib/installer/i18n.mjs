import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from '../private-file.mjs'

const contexts = new AsyncLocalStorage()
const localizedPrompters = new WeakSet()
export const tuiSettingsPath = () => join(searchBoostHome(), 'config', 'tui.json')

/** Menu layouts: flat lists every entry on the home menu, folder keeps the categories. */
export const TUI_LAYOUTS = ['flat', 'folder']
/** An unsaved layout — including a language-only legacy config — is flat. */
export const DEFAULT_TUI_LAYOUT = 'flat'

export function systemLanguage(env = process.env, locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE?.split(':')[0] || locale
  return /^zh(?:[-_.@]|$)/i.test(value) ? 'zh-CN' : 'en'
}

function settingsDocument() {
  const { doc, error } = readJsonStore(tuiSettingsPath())
  if (error) throw error
  if (doc?.language != null && !['en', 'zh-CN'].includes(doc.language)) {
    throw new Error('Invalid TUI language in tui.json; expected en or zh-CN')
  }
  if (doc?.layout != null && !TUI_LAYOUTS.includes(doc.layout)) {
    throw new Error('Invalid TUI layout in tui.json; expected flat or folder')
  }
  return doc ?? {}
}

export function readTuiLanguage() {
  return settingsDocument().language ?? systemLanguage()
}

export function readTuiLayout() {
  return settingsDocument().layout ?? DEFAULT_TUI_LAYOUT
}

/** One read for the TUI shell: saved display language plus menu layout. */
export function readTuiSettings() {
  const doc = settingsDocument()
  return { language: doc.language ?? systemLanguage(), layout: doc.layout ?? DEFAULT_TUI_LAYOUT }
}

/** Read-modify-write under the shared lock: other saved fields stay untouched. */
function saveTuiSettings(patch) {
  const file = tuiSettingsPath()
  return withFileLock(file, () => {
    const doc = settingsDocument()
    writeFileAtomicPrivate(file, `${JSON.stringify({ ...doc, ...patch }, null, 2)}\n`)
  })
}

export function saveTuiLanguage(language) {
  if (!['en', 'zh-CN'].includes(language)) throw new Error('Unsupported TUI language')
  return saveTuiSettings({ language })
}

export function saveTuiLayout(layout) {
  if (!TUI_LAYOUTS.includes(layout)) throw new Error('Unsupported TUI layout')
  return saveTuiSettings({ layout })
}

export function layoutLabel(layout) {
  return layout === 'folder' ? t('Folder', '文件夹') : t('Flat', '平铺')
}

export function tuiContext() { return contexts.getStore() }

/** Non-interactive CLI output deliberately stays in its original language. */
export function t(english, chinese) {
  return tuiContext()?.language === 'zh-CN' ? chinese : english
}

/** Context is per interactive invocation, not a process-wide language default. */
export function withTuiContext(work, { language, layout, navigation = false } = {}) {
  let settingsError
  if (language === undefined) {
    try {
      const settings = readTuiSettings()
      language = settings.language
      layout = layout ?? settings.layout
    } catch (err) {
      language = systemLanguage()
      layout = layout ?? DEFAULT_TUI_LAYOUT
      settingsError = err
    }
  }
  return contexts.run({ language, layout: layout ?? DEFAULT_TUI_LAYOUT, navigation }, () => {
    if (settingsError) {
      console.warn(t('Could not read TUI settings; using the system language.', '无法读取 TUI 设置，暂时使用系统语言。'))
      console.warn(settingsError.message)
    }
    return work()
  })
}

export class TuiCancelled extends Error {}
export class TuiExit extends TuiCancelled {}

/** Keep values, input, snippets and upstream errors untouched. Only Clack chrome is localized. */
export function localizedClack(clack) {
  if (localizedPrompters.has(clack)) return clack
  const wrapped = { ...clack }
  for (const method of ['select', 'multiselect', 'text', 'password', 'confirm']) {
    if (!clack[method]) continue
    wrapped[method] = async (options) => {
      const context = tuiContext()
      let interrupted = false
      const onKey = (_text, key) => {
        if (key?.ctrl && key.name === 'c') interrupted = true
      }
      process.stdin.on('keypress', onKey)
      try {
        const value = await clack[method](method === 'confirm'
          ? { active: t('Yes', '是'), inactive: t('No', '否'), ...options }
          : options)
        if (clack.isCancel(value) && interrupted && context?.navigation) throw new TuiExit()
        return value
      } finally {
        process.stdin.off('keypress', onKey)
      }
    }
  }
  localizedPrompters.add(wrapped)
  return wrapped
}

export function nativeStateLabel(state) {
  const labels = {
    replaced: t('replaced', '已替换'), native: t('native', '原生可用'),
    prompt: t('prompt', '提示优先'), left: t('left', '保留原生'), unknown: '-',
  }
  return labels[state] ?? state
}

/** Primary capability descriptions are translated here, not in agent configuration. */
export function nativeSearchNote(id, original) {
  if (tuiContext()?.language !== 'zh-CN') return original
  return {
    cursor: '无配置开关；搜索时由 hook 和 skill 提示优先使用 search-boost。',
    'cursor-cli': '无配置开关；使用与 Cursor IDE 相同的 hook 和 skill。',
    codex: '在 ~/.codex/config.toml 中写入 web_search = "disabled"（SEARCH_BOOST 标记）。',
    claude: '将 WebSearch 加入 ~/.claude/settings.json 的 permissions.deny。',
    grok: '不修改；保留 Grok 原生浏览用于开放式探索。',
    antigravity: '无配置开关；注入提示优先使用 search-boost，而非 search_web / read_url_content。',
  }[id] ?? original
}

export function credentialSource(source) {
  return {
    file: t('file', '文件'), env: t('env', '环境变量'), local: t('local', '本地'),
    none: t('none', '无'), 'grok-pending': t('grok-pending', 'Grok 待导入'),
  }[source] ?? source
}

export function xAuthDetail(status) {
  if (tuiContext()?.language !== 'zh-CN') return status.detail
  if (status.source === 'none') return '无凭据 — 请运行 search-boost config x --import-grok（或 MCP 中的 /x-login），也可设置 XAI_API_KEY'
  // Only known display scaffolding is changed; masked credentials/paths remain original.
  return status.detail
    .replace(/^XAI_API_KEY env \(/, 'XAI_API_KEY 环境变量（')
    .replace(/, public api\.x\.ai\)/, '，公共 api.x.ai）')
    .replace(/, imported (\S+)$/, '，导入日期 $1')
    .replace(/ — not imported$/, ' — 尚未导入')
    .replace(/, expires ([\dTZ:.-]+) \((\d+)min\)/, '，到期时间 $1（$2 分钟）')
    .replace(/, EXPIRED$/, '，已过期')
}

export function toolHint(name, original) {
  return {
    fused_search: t(original, 'MCP / Pi / DSH · 多引擎搜索'),
    fetch_page: t(original, 'MCP / Pi / DSH · 页面阅读'),
    x_search: t(original, 'MCP / Pi / DSH · X 搜索'),
    adaptive_search: t(original, 'MCP / Pi / DSH · 需要 Jev'),
    research_parallel: t(original, 'Pi: search-parallel-subagent / DSH: research_parallel'),
    search_stats: t(original, 'MCP / DSH · 搜索诊断'),
    search_layer: t(original, 'MCP · 搜索层切换'),
  }[name] ?? original
}

export function toolUnavailableReason(reason) {
  if (reason === 'Jev not configured — configure Jev credentials first') return t(reason, '未配置 Jev — 请先配置 Jev 凭据')
  if (reason === 'Jev configuration unreadable — repair credentials first') return t(reason, '无法读取 Jev 配置 — 请先修复凭据')
  return reason
}

export function integrationWarning(warning) {
  const prefix = 'Recorded project unavailable: '
  if (warning.startsWith(prefix)) return t(warning, `已记录的项目不可用：${warning.slice(prefix.length)}`)
  // Labels and original lower-level errors are diagnostic evidence, not translated prose.
  return warning
}

export function pluginUpgradeMessage(message) {
  const translations = {
    'Grok plugin source and cached payload already match; no host update was needed.': 'Grok 插件源与缓存内容已一致，无需宿主更新。',
    'Grok plugin cache rebuilt by the host with data retained and explicit source trust; payload verified. Restart Grok.': 'Grok 已由宿主保留数据重建缓存，并经明确授权信任当前源；内容已核验，请重启 Grok。',
    'Would verify/refresh the existing Grok plugin without changing trust.': '将核验/刷新已有 Grok 插件，不改变信任。',
    'Grok plugin discovery failed; no success assumed.': 'Grok 插件发现失败，不判定成功。',
    'Grok CLI unavailable; plugin installation could not be inspected.': 'Grok CLI 不可用，无法检查插件安装状态。',
    'Grok plugin discovery failed; no success assumed.': 'Grok 插件发现失败，不能确认成功。',
    'Grok plugin list returned invalid JSON.': 'Grok 插件列表返回了无效 JSON。',
    'Unsupported Grok plugin list format.': '不支持此 Grok 插件列表格式。',
    'No existing Grok plugin; not installing a new one.': '未发现已有 Grok 插件，不安装新插件。',
    'Grok plugin is disabled; registration left unchanged, not re-enabled.': 'Grok 插件已停用，保留原注册，不重新启用。',
    'Would refresh the existing Grok plugin without changing trust.': '将刷新已有 Grok 插件，不修改信任设置。',
    'Grok plugin source verified; restart the host to reload.': 'Grok 插件来源已验证，请重启宿主以重新加载。',
    'Grok plugin source and cached payload verified; restart the host to reload.': 'Grok 插件来源与缓存载荷已验证，请重启宿主以重新加载。',
  }
  return t(message, translations[message] ?? message)
}

export function pluginUpgradeStatus(status) {
  return {
    current: t(status, '已同步'),
    unavailable: t(status, '不可用'), failed: t(status, '失败'), absent: t(status, '未安装'),
    disabled: t(status, '已停用'), planned: t(status, '已计划'), updated: t(status, '已更新'),
  }[status] ?? status
}
