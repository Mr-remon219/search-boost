/** Independent full-screen console. No Clack prompts or legacy TUI navigation. */
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { KEY_NAMES, ENV_MAP, readKeys, readKeysFileDocument, readKeysRouting, writeKeysFile, envKeySet } from './keys.mjs'
import { ENGINE_BASE_URLS, normalizeEngineBaseUrl } from './engine-endpoints.mjs'
import { getLayer, setLayer } from './layer-config.mjs'
import { toolStates, saveToolPreferences } from './tool-config.mjs'
import { communityCapabilities, readCommunityConfig, communityRegistry, isBuiltInCommunityBackend, planCommunityPlatformChange, applyCommunityPlatformPlan } from './community/config.mjs'
import { readJudgmentConfig, readJudgmentProfiles, saveJudgmentProfile, activateJudgmentProfile, removeJudgmentProfile } from './judgment/config.mjs'
import { normalizeJevBaseUrl } from './jev-config.mjs'
import { normalizeDecisionBaseUrl } from './judgment/contract.mjs'
import { decisionRegistry } from './judgment/registry.mjs'
import { AGENTS, AGENT_IDS, agentStatus } from './agents/index.mjs'
import { collectRuntimeCapabilities } from './search/capability.js'
import { authStatus, readGrokAuth, importFromGrok, readPiAuth, importApiKey, logout as logoutX } from './search/x/xauth.js'
import { readTuiSettings, saveTuiLanguage, systemLanguage } from './installer/i18n.mjs'
import { searchBoostHome } from './config-paths.mjs'
import { getVersion } from './pkg.mjs'
import { QUOTA_PROVIDERS, QUOTA_REFRESH_MS, quotaIdentity, quotaAvailability, fetchEngineQuota } from './engine-quota.mjs'
import { CONSOLE_THEMES, DEFAULT_CONSOLE_THEME, CONSOLE_LOGO, consoleTheme, consoleSettingsPath, readConsoleTheme, saveConsoleTheme, paintConsole } from './console-theme.mjs'

const ESC = '\x1b['
const RESET = `${ESC}0m`
// Never let config values, errors or pasted text inject terminal commands.
export const cleanText = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function charWidth(text) {
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(text)) return 0
  if (/\p{Extended_Pictographic}/u.test(text)) return 2
  const c = text.codePointAt(0)
  return c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
    (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe6f) ||
    (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000) ? 2 : 1
}
export function displayWidth(text) {
  return [...segments.segment(cleanText(text))].reduce((n, s) => n + charWidth(s.segment), 0)
}
export function fitText(text, width) {
  width = Math.max(0, width)
  const safe = cleanText(text)
  const truncated = displayWidth(safe) > width
  let out = '', used = 0
  for (const { segment } of segments.segment(safe)) {
    const n = charWidth(segment)
    if (used + n > width - (truncated ? 1 : 0)) break
    out += segment; used += n
  }
  if (truncated && width) { out += '…'; used++ }
  return out + ' '.repeat(Math.max(0, width - used))
}
function wrapText(text, width) {
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    let line = '', used = 0
    for (const { segment } of segments.segment(cleanText(paragraph))) {
      const n = charWidth(segment)
      if (used + n > width && line) { lines.push(line); line = ''; used = 0 }
      line += segment; used += n
    }
    lines.push(line)
  }
  return lines
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const SECTIONS = [
  ['overview', '总览', 'Overview'], ['engines', '搜索引擎', 'Engines'],
  ['search', '搜索层', 'Search layer'], ['tools', '工具开关', 'Tools'],
  ['community', '社区检索', 'Community'], ['judgment', '判断模型', 'Judgment'],
  ['agents', 'Agent 接入', 'Integrations'], ['settings', '界面设置', 'Settings'],
]
const PLATFORM_NAMES = { reddit: 'Reddit', x: 'X', bilibili: 'Bilibili', zhihu: 'Zhihu', xiaohongshu: 'Xiaohongshu' }
const PROVIDER_NAMES = { 'existing-x': 'X', 'reddit-arctic': 'Reddit archive', 'bilibili-public': 'Public video API' }
const providerLabel = id => PROVIDER_NAMES[id] ?? (id.endsWith('-browser') ? 'Browser cards' : 'Web index')
const item = (id, label, status, details, actions = []) => ({ id, label, status, details, actions })
const action = (id, label, run) => ({ id, label, run })

/** Service injection is for hermetic tests; rendering never contains credentials. */
export class ConsoleModel {
  constructor({ dryRun = false, language, theme, services = {} } = {}) {
    this.services = { readKeys, readKeysFileDocument, readKeysRouting, writeKeysFile, envKeySet,
      getLayer, setLayer, toolStates, saveToolPreferences, fetchEngineQuota, now: Date.now, collectRuntimeCapabilities, communityCapabilities, readCommunityConfig,
      planCommunityPlatformChange, applyCommunityPlatformPlan, readJudgmentConfig, readJudgmentProfiles, saveJudgmentProfile,
      activateJudgmentProfile, removeJudgmentProfile, agentStatus, saveTuiLanguage, readConsoleTheme, saveConsoleTheme, authStatus, readGrokAuth, importFromGrok, readPiAuth, importApiKey, logoutX, agents: AGENTS, ...services }
    this.dryRun = dryRun
    this.section = 0; this.selection = {}; this.focus = 'list'; this.modal = null
    this.detailViews = new Map(); this.viewport = { width: 42, height: 22 }
    this.quotaCache = new Map(); this.quotaTask = null; this.quotaLoading = new Set()
    this.notice = ''; this.busy = false; this.closed = false; this.onChange = () => {}
    try { this.language = language ?? readTuiSettings().language } catch {
      this.language = language ?? systemLanguage()
      this.notice = this.tr('显示设置不可读；不会覆盖损坏文件。', 'Display settings unreadable; damaged files will not be overwritten.')
    }
    try {
      this.theme = theme ?? this.services.readConsoleTheme()
      if (!Object.hasOwn(CONSOLE_THEMES, this.theme)) throw new Error('Unsupported console theme')
    } catch {
      this.theme = DEFAULT_CONSOLE_THEME
      this.notice = this.tr('控制台主题设置不可读；使用 Ayu Dark，不会覆盖损坏文件。', 'Console theme settings unreadable; using Ayu Dark without overwriting the damaged file.')
    }
    this.reload()
  }
  tr(zh, en) { return this.language === 'zh-CN' ? zh : en }
  get sectionId() { return SECTIONS[this.section][0] }
  get title() { return SECTIONS[this.section][this.language === 'zh-CN' ? 1 : 2] }
  get rows() { return this.pages[this.sectionId] ?? [] }
  get index() { return Math.min(this.selection[this.sectionId] ?? 0, Math.max(0, this.rows.length - 1)) }
  get current() { return this.rows[this.index] }
  changed() { this.onChange() }
  reload() {
    const selectedIds = Object.fromEntries(Object.entries(this.pages ?? {}).map(([id, rows]) => [id, rows[this.selection[id] ?? 0]?.id]))
    const s = this.services, tr = this.tr.bind(this), pages = {}
    const safePage = (id, build) => {
      try { pages[id] = build() } catch {
        pages[id] = [item('error', tr('配置不可读', 'Configuration unreadable'), '!', [
          tr('请修复对应配置文件后按 R 刷新。不会将损坏配置当作空配置覆盖。', 'Repair this configuration and press R. Damaged configuration is never treated as empty.'),
          `${searchBoostHome()}/config`,
        ])]
      }
    }
    safePage('engines', () => {
      const routing = s.readKeysRouting(), doc = s.readKeysFileDocument().doc
      const rows = KEY_NAMES.map(name => {
        const configured = Boolean(routing.keys[name]), enabled = routing.enabledNames.includes(name)
        const source = typeof doc[name] === 'string' && doc[name].trim() ? 'file' : configured ? 'env' : 'missing'
        const base = routing.baseUrls[name]
        const row = item(name, name, configured ? enabled ? tr('已启用', 'Enabled') : tr('已停用', 'Disabled') : tr('未配置', 'No key'), [
          tr('API 搜索引擎', 'API search engine'),
          `${tr('凭据来源', 'Credential source')}: ${source} · ${configured ? '••••••••' : '—'}`,
          `${tr('环境变量', 'Environment')}: ${ENV_MAP[name]}`,
          `Base URL: ${base}`, `${base === ENGINE_BASE_URLS[name] ? tr('官方地址', 'Default endpoint') : tr('自定义网关', 'Custom gateway')}`,
          tr('配置状态不代表网络连通。保存 Key 不会自动改变已有路由。', 'Configuration is not a connectivity test. Saving a key preserves existing routing.'),
          ...(name === 'anysearch' ? [tr('免费池支持匿名检索；此处管理有 Key 的 API 路由。', 'The free pool supports anonymous requests; this page manages keyed API routing.')] : []),
        ], [
          action('edit', tr('设置 / 更换 Key', 'Set / replace key'), () => this.editKey(name)),
          action('url', tr('修改 Base URL', 'Edit Base URL'), () => this.editUrl(name, base)),
          action('reset', tr('恢复官方地址', 'Restore default URL'), () => this.keyPatch({ baseUrls: { [name]: null } }, `${name}: ${ENGINE_BASE_URLS[name]}`)),
          ...(configured ? [action('toggle', enabled ? tr('停用 API 路由', 'Disable API routing') : tr('启用 API 路由', 'Enable API routing'), () => this.toggleEngine(name))] : []),
          ...(source === 'file' ? [action('delete', tr('移除文件 Key', 'Remove stored key'), () => this.keyPatch({ [name]: undefined }, tr(`移除 ${name} 的文件 Key；环境变量保持不变。`, `Remove the stored ${name} key; environment credentials are unchanged.`)))] : []),
          action('quota-view', tr('查看额度详情（只读）', 'View quota details (read-only)'), () => this.showQuotaOverview([name])),
          action('quota', name === 'brave' ? tr('查看配额（查询消耗 1 次搜索）', 'Check quota (uses 1 search)') : tr('查看 API 额度', 'Check API quota'), () => this.requestQuota([name])),
        ])
        row.quota = { name, ...this.quotaState(name, routing) }
        return row
      })
      rows.push(item('quota-overview', tr('API 额度总览', 'API quota overview'), tr('控制台专属', 'Console only'), [
        tr('汇总各引擎最新额度快照；进入页面不联网。U 或第三栏操作显式查询。', 'All engines in one place; opening this view stays offline. U or a detail-pane action explicitly queries providers.'),
        tr('不同引擎的 credits、请求配额与账户余额不相加。', 'Credits, request quotas and account balances are never added together.'),
      ], [action('view', tr('查看额度总览', 'View quota overview'), () => this.showQuotaOverview()),
        action('quota', tr('查询支持的引擎额度', 'Query supported engine quotas'), () => this.requestQuota())]))
      rows.at(-1).quotaOverview = KEY_NAMES.map(name => ({ name, ...this.quotaState(name, routing) }))
      return rows
    })
    safePage('search', () => ['free', 'api'].map(layer => item(layer, layer.toUpperCase(), s.getLayer() === layer ? tr('当前', 'Active') : '—', [
      layer === 'free' ? tr('无需 Key：bing / ddg / exa-free / anysearch。', 'Keyless engines: bing / ddg / exa-free / anysearch.') : tr('使用已配置的 API 引擎；无 Key 时回退免费引擎。', 'Use configured API engines; fall back to free engines when no keys are available.'),
      tr('影响默认搜索层，不修改引擎凭据或单次请求参数。', 'Changes the default layer, not credentials or per-request parameters.'),
    ], [action('activate', tr('设为默认', 'Use as default'), () => this.confirm(`${tr('默认搜索层', 'Default layer')}: ${layer}`, () => s.setLayer(layer)))])))
    safePage('tools', () => s.toolStates().map(row => item(row.name, row.name, row.locked ? tr('待配置', 'Locked') : row.enabled ? tr('已启用', 'Enabled') : tr('已停用', 'Disabled'), [row.hint, row.reason,
      tr('只控制工具入口，不等同于内部引擎权限。宿主可能需要重启 / 重连。', 'Controls tool entries, not internal engine permissions. Hosts may need a restart / reconnect.'),
    ], row.locked ? [] : [action('toggle', tr('切换开关', 'Toggle'), () => this.confirm(`${row.name} → ${row.enabled ? 'OFF' : 'ON'}`, () => s.saveToolPreferences({ [row.name]: !row.enabled })))])))
    safePage('community', () => {
      let context = {}, runtimeUnavailable = false
      try { context = s.collectRuntimeCapabilities() } catch { runtimeUnavailable = true }
      const cap = s.communityCapabilities(context)
      const doc = s.readCommunityConfig()
      if (cap.error) throw new Error('Unreadable community store')
      return cap.platforms.map(({ platform }) => {
        const backends = cap.backends.filter(b => b.platform === platform), active = backends.filter(b => b.enabled)
        return item(platform, PLATFORM_NAMES[platform], active.length ? active.some(b => b.ready) ? tr('已启用', 'Enabled') : tr('待配置', 'Needs setup') : tr('已停用', 'Disabled'), [
          ...backends.flatMap(b => {
            const config = doc.backends.find(row => row.id === b.id).config
            return [`${b.enabled ? '●' : '○'} ${providerLabel(b.provider)} · ${b.id}${b.enabled && !b.ready ? ` · ${b.reason}` : ''}`,
              ...(b.provider === 'reddit-arctic' ? [tr('默认社区', 'Default subreddits') + ': ' + (config.subreddits?.join(', ') || tr('自动发现', 'Auto-discover'))] : []),
              ...(config.endpoint ? [`Bridge: ${config.endpoint}`, `Token env: ${config.token_env}`] : [])]
          }),
          ...(runtimeUnavailable ? [tr('搜索运行配置不可读；检索就绪状态可能不完整。仍可管理平台配置。', 'Search runtime configuration unreadable; readiness may be incomplete. Platform settings remain manageable.')] : []),
          ...(platform === 'x' ? [`Auth: ${s.authStatus().source ?? 'none'}`] : []),
          tr('平台开关只决定可用来源；每次搜索是否加入社区仍由 community 参数决定。', 'Platform switches control available sources; each search opts in with community.'),
          tr('仅配置就绪状态，不验证网络、浏览器登录或检索覆盖率。', 'Configuration readiness only, not connectivity, browser login or coverage.'),
        ], [action('view', tr('查看完整配置', 'View full configuration'), () => this.showText(this.pages.community.find(row => row.id === platform).details, PLATFORM_NAMES[platform])),
          action('edit', tr('启用 / 更换检索方式', 'Enable / change source'), () => this.chooseCommunity(platform)),
          ...doc.backends.filter(b => communityRegistry.get(b.provider).platform === platform && (b.provider === 'reddit-arctic' || b.provider.endsWith('-browser'))).map(b => action(`configure:${b.id}`, `${tr('编辑', 'Edit')} ${providerLabel(b.provider)} · ${b.id}`, () => this.configureCommunity(platform, b))),
          ...doc.backends.filter(b => communityRegistry.get(b.provider).platform === platform && !isBuiltInCommunityBackend(b.id)).map(b => action(`remove:${b.id}`, `${tr('删除额外配置', 'Delete extra configuration')} · ${b.id}`, () => this.communityChange(platform, { action: 'remove', id: b.id }))),
          ...(active.length ? [action('toggle', tr('停用此平台', 'Disable platform'), () => this.communityChange(platform, { action: 'disable' }))] : []),
          ...(platform === 'x' ? [...(s.readGrokAuth() ? [action('import', tr('导入已有 Grok 登录', 'Import existing Grok login'), () => this.confirm(tr('仅复制到本地 X 凭据；不改变平台启停。', 'Copy credentials locally; platform enablement is unchanged.'), () => s.importFromGrok()))] : []), action('credential', tr('设置 xAI API Key', 'Set xAI API key'), () => this.form('X · xAI API Key', [{ label: 'API Key', secret: true, required: true, validate: value => { if (!value.startsWith('xai-')) throw new Error('Invalid xAI key') } }], ([value]) => this.confirm(tr('保存本地 xAI Key；不改变平台启停状态。', 'Save the local xAI key; platform enablement is unchanged.'), () => s.importApiKey(value)))),
            ...(s.readPiAuth() ? [action('delete', tr('移除本地 X 凭据', 'Remove local X credentials'), () => this.confirm(tr('只移除本地副本；Grok 登录和环境变量保持不变。', 'Remove only the local copy; Grok login and environment credentials are unchanged.'), () => s.logoutX()))] : [])] : [])])
      })
    })
    safePage('judgment', () => {
      const store = s.readJudgmentProfiles()
      const profiles = Object.entries(store.profiles).filter(([, p]) => p.provider !== 'jev' || p.apiKey)
      const active = profiles.find(([id]) => id === store.activeProfile)
      const config = s.readJudgmentConfig()
      const summary = [
        active ? `${active[0]} · ${active[1].provider} · ${active[1].model}\nBase URL: ${active[1].baseUrl}` : tr('未选择判断配置；判断已停用。', 'No active profile; judgments are disabled.'),
        tr('专用判断服务；普通搜索不需要配置。', 'Dedicated judgment services; ordinary search does not require one.'),
        tr('问题、方向与必要材料片段发送至所选服务；引擎 Key 不会发送。', 'Questions, intent and necessary fragments go to the selected service; engine keys do not.'),
        ...(active?.[1].provider === 'laya' ? [`Capacity: ${config.capacityStatus}`] : []),
        tr('仅本地配置状态，不代表连接、容量或判断质量。', 'Local configuration only, not connectivity, capacity or model quality.'),
      ]
      const rows = profiles.sort(([a], [b]) => Number(b === store.activeProfile) - Number(a === store.activeProfile)).map(([id, p]) => {
        const destination = decisionRegistry.configurationFor(p.provider, p.baseUrl)
        const details = [`${p.provider} · ${p.model}`, `Base URL: ${p.baseUrl}`, `Endpoint: ${destination.endpoint}`, `Transport: ${destination.transport}`, `Auth: ${p.authMode} · ${p.apiKey ? '••••••••' : 'none'}`,
          ...(p.options ? [`max_len: ${p.options.max_len ?? 'default'} · head_max_len: ${p.options.head_max_len ?? 'default'}`] : []),
          ...(p.provider === 'laya' ? [tr('Laya 需要离线容量证据；保存配置不保证判断可用。', 'Laya requires offline capacity evidence; saving does not guarantee judgment availability.')] : []),
          tr('编辑不切换当前配置；使用此配置才会更换判断目的地。', 'Editing does not switch the active profile; activation changes the judgment destination.')]
        return item(`profile:${id}`, id, store.activeProfile === id ? tr('当前', 'Active') : p.provider, details, [
          action('view', tr('查看完整配置', 'View full configuration'), () => this.showText(details, id)),
          action('edit', tr('编辑此配置', 'Edit profile'), () => this.editJudgment(id)),
          ...(store.activeProfile !== id ? [action('activate', tr('使用此配置', 'Activate profile'), () => this.confirm(`${id}: ${destination.endpoint}\n${summary[2]}`, () => {
            if (!equal(store, s.readJudgmentProfiles())) throw new Error('Profiles changed')
            s.activateJudgmentProfile(id)
          }))] : []),
          action('delete', tr('删除配置与 Key', 'Delete profile and key'), () => this.confirm(tr(`删除 ${id}；删除当前配置后不会自动选择其他目的地。`, `Delete ${id}; deleting the active profile does not select another destination.`), () => {
            if (!equal(store, s.readJudgmentProfiles())) throw new Error('Profiles changed')
            s.removeJudgmentProfile(id)
          })),
        ])
      })
      return [item('status', tr('当前判断状态', 'Current judgment status'), active ? active[1].provider : tr('未配置', 'Not configured'), summary, [
        action('view', tr('查看判断状态', 'View judgment status'), () => this.showText(summary)),
        action('edit', tr('选择已保存配置', 'Select saved profile'), () => this.choose(this.tr('选择判断配置', 'Select judgment profile'), [
          ...profiles.map(([id, p]) => ({ label: `${id} · ${p.provider} · ${p.model}${id === store.activeProfile ? ' · ●' : ''}`, run: () => {
            if (id === store.activeProfile) this.showText(summary)
            else this.confirm(`${id}: ${p.baseUrl}\n${summary[2]}`, () => {
              if (!equal(store, s.readJudgmentProfiles())) throw new Error('Profiles changed')
              s.activateJudgmentProfile(id)
            })
          } })),
          { label: tr('添加新配置', 'Add new profile'), run: () => this.addJudgment() },
        ], option => option.run())),
      ]), ...rows, item('new', tr('添加判断模型', 'Add judgment profile'), 'Jev / Laya', summary, [action('edit', tr('新建配置', 'New profile'), () => this.addJudgment())])]
    })
    safePage('agents', () => AGENT_IDS.map(id => {
      const state = s.agentStatus(id)
      return item(id, AGENTS[id].label, state.configured ? tr('已配置', 'Configured') : state.detected ? tr('已检测', 'Detected') : tr('未检测', 'Not detected'), [
        tr('磁盘配置状态，不代表运行中的宿主已加载。变更后重启 / 重连宿主。', 'Disk configuration only, not live host loading. Restart / reconnect after changes.'),
        ...(id === 'grok' ? [tr('此控制台仅管理用户级 MCP / 规则 / skill，不改动 Grok 原生插件。完整插件管理使用独立 CLI。', 'This console manages user-scope MCP / rules / skills only; the Grok native plugin is unchanged. Use the CLI for full plugin management.')] : []),
        ...(id === 'dsh' ? [tr('操作前选择精确 profile；Desktop 需先完全退出（含托盘）。', 'Choose an exact profile; fully quit Desktop including its tray first.')] : []),
        tr('安装不自动授予工具权限、不替换原生搜索；已有接入建议刷新以保留选择。', 'Install does not auto-approve tools or replace native search. Refresh existing integrations to preserve choices.'),
      ], [action('install', tr('安装接入', 'Install integration'), () => this.agentOperation(id, false)),
        action('refresh', tr('刷新已有接入', 'Refresh existing integration'), () => this.refreshAgent(id)),
        action('snippet', tr('查看接入配置', 'View integration snippet'), () => this.showText(AGENTS[id].printConfig({ autoAllow: false, replaceNative: false, scope: 'user' }))),
        ...(state.configured ? [action('delete', tr('卸载接入', 'Uninstall integration'), () => this.agentOperation(id, true))] : [])])
    }))
    pages.settings = [item('language', tr('显示语言', 'Display language'), this.language === 'zh-CN' ? '简体中文' : 'English', [
      tr('切换立即生效，保留旧 TUI 的布局偏好；两套界面只共用显示语言。', 'Applies immediately; the legacy layout preference is preserved. The two interfaces share only the language preference.'),
    ], [action('edit', tr('切换语言', 'Switch language'), () => this.switchLanguage())]),
    item('theme', tr('主题（控制台专属）', 'Theme (console only)'), consoleTheme(this.theme).name, [
      tr('Ayu Dark：深色底、暖金强调；TokyoNight Dark：深蓝底、蓝紫强调。', 'Ayu Dark: dark background and warm gold; TokyoNight Dark: deep blue background and blue/purple accents.'),
      tr('主题同时用于导航、详情、表单、额度卡片与 Logo；确认后立即生效。', 'Themes apply to navigation, details, forms, quota cards and the logo; confirmation applies immediately.'),
      tr('只影响控制台；快速配置 TUI 的语言与布局保持不变。', 'Console only; the quick TUI language and layout are unchanged.'),
      tr('无颜色模式保留 Logo 与布局，不输出主题颜色。', 'No-color mode keeps the logo and layout without themed colors.'),
      consoleSettingsPath(),
    ], [action('edit', tr('切换主题', 'Change theme'), () => this.chooseTheme())]),
    item('keys', tr('快捷键指南', 'Keyboard guide'), '?', this.helpLines()),
    item('storage', tr('配置位置', 'Configuration location'), 'LOCAL', [searchBoostHome(),
      tr('浏览不联网、不创建默认配置。所有提交显式确认，删除默认取消。', 'Browsing is offline and does not create defaults. Writes require confirmation; deletion defaults to cancel.'),
      tr('软件包更新交给 npm；此界面不执行自动更新。', 'Package updates are managed by npm; this UI does not auto-update.')])]
    const engines = pages.engines.filter(r => r.status === tr('已启用', 'Enabled')).length
    const hosts = pages.agents.filter(r => r.status === tr('已配置', 'Configured')).length
    pages.overview = [
      item('welcome', tr('SearchBoost 控制中心', 'SearchBoost control center'), `v${getVersion()}`, [
        tr('独立全屏控制台 · 固定导航 · 原地编辑', 'Independent full-screen console · fixed navigation · inline editing'),
        `${tr('配置目录', 'Config home')}: ${searchBoostHome()}`,
        tr('建议：配置搜索引擎 → 选择搜索层 → 安装 Agent 接入。', 'Start here: configure engines → choose a layer → install integrations.'),
        tr('旧向导仍由 search-boost 启动，新控制台由 search-boost tui 启动。', 'search-boost opens the legacy wizard; search-boost tui opens this console.'),
      ]),
      item('engines', tr('API 引擎', 'API engines'), `${engines}/${KEY_NAMES.length}`, [tr('查看凭据来源、API 地址和启停状态。', 'Inspect credential sources, endpoints and routing.')], [action('open', tr('打开引擎配置', 'Open engines'), () => this.navigate(1))]),
      item('agents', tr('Agent 接入', 'Integrations'), `${hosts}/${AGENT_IDS.length}`, [tr('磁盘配置统计，非运行时握手。', 'Disk configuration count, not a runtime handshake.')], [action('open', tr('管理接入', 'Manage integrations'), () => this.navigate(6))]),
      item('doctor', tr('离线诊断', 'Offline diagnostics'), tr('只读', 'Read-only'), [tr('检查配置与接入；不会发起搜索或网络探测。', 'Check configuration and integrations without search or network probes.')], [action('check', tr('运行诊断', 'Run diagnostics'), () => this.doctor())]),
    ]
    // Action lists can also change after toggling, activating or deleting.
    // Keep an action by identity; if it disappeared, fall back to the first action
    // rather than leaving focus on an unrelated (possibly destructive) button.
    for (const [id, rows] of Object.entries(pages)) for (const row of rows) {
      const view = this.detailViews.get(`${id}:${row.id}`)
      if (!view) continue
      const oldRow = this.pages?.[id]?.find(previous => previous.id === row.id)
      const actionId = oldRow?.actions[view.actionIndex]?.id
      view.actionIndex = Math.max(0, row.actions.findIndex(action => action.id === actionId))
    }
    this.pages = pages
    for (const [id, selectedId] of Object.entries(selectedIds)) {
      const index = pages[id]?.findIndex(row => row.id === selectedId) ?? -1
      this.selection[id] = index >= 0 ? index : Math.min(this.selection[id] ?? 0, Math.max(0, (pages[id]?.length ?? 0) - 1))
    }
    this.changed()
  }
  helpLines() {
    return [this.tr('Tab / Shift+Tab：依次切换分类、列表、详情三栏', 'Tab / Shift+Tab: cycle categories, list and details'),
      this.tr('← / →：切换相邻栏；Esc：详情 → 列表 → 分类', '← / →: adjacent pane; Esc: details → list → categories'),
      this.tr('Enter：列表进入详情；详情执行选中的操作', 'Enter: list → details; in details run the selected action'),
      this.tr('↑↓ / J K：移动列表或详情操作；Home / End：首尾', '↑↓ / J K: move through lists or detail actions; Home / End: first / last'),
      this.tr('PgUp / PgDn：列表翻页 / 详情滚动；只读详情也可用 ↑↓', 'PgUp / PgDn: list pages / detail scrolling; read-only details also support ↑↓'),
      this.tr('1–8：跳转分类；Space：切换开关（需确认）', '1–8: sections; Space: toggle (confirmation required)'),
      this.tr('E：编辑；D：删除；R：刷新（保留选中条目）', 'E: edit; D: delete; R: reload (keep the selected item)'),
      this.tr('U：查询引擎额度（需确认联网）；总览内查询全部支持项', 'U: query engine quotas (network consent); overview queries supported engines'),
      this.tr('弹窗留在详情栏；Esc 返回上一步，不保存', 'Dialogs stay in details; Esc returns one step without saving'),
      this.tr('表单 Tab 切换字段；←→ / Home / End 移动光标；Delete 删除；Ctrl+U 清空', 'Forms: Tab switches fields; ←→ / Home / End move caret; Delete deletes; Ctrl+U clears'),
      this.tr('确认默认取消；PgUp / PgDn 查看完整说明', 'Confirmation defaults to cancel; PgUp / PgDn show the full description'),
      this.tr('?：帮助；L：语言；Q / Ctrl+C：退出（输入框内 Q 是文本）', '?: help; L: language; Q / Ctrl+C: quit (Q in forms is text)'),
      this.tr('忙碌时 Ctrl+C 请求操作完成后退出，避免中断配置写入', 'While busy, Ctrl+C requests exit after completion to avoid interrupting writes')]
  }
  navigate(index) { this.section = index; this.focus = 'list'; this.modal = null; this.changed() }
  get detailView() {
    const id = `${this.sectionId}:${this.current?.id ?? ''}`
    if (!this.detailViews.has(id)) this.detailViews.set(id, { actionIndex: 0, scroll: 0 })
    return this.detailViews.get(id)
  }
  openModal(modal, { replace = false } = {}) {
    const previous = this.modal ?? this.transitionModal ?? null
    const parent = replace ? null : previous
    this.modal = { ...modal, parent, returnFocus: previous?.returnFocus ?? this.focus }
    this.focus = 'detail'
    this.changed()
  }
  closeModal(back = true, modal = this.modal ?? this.transitionModal) {
    this.modal = back ? modal?.parent ?? null : null
    this.focus = this.modal ? 'detail' : modal?.returnFocus ?? this.focus
    this.changed()
  }
  showText(text, title = this.tr('详情', 'Details'), options) { this.openModal({ kind: 'text', title, lines: Array.isArray(text) ? text : String(text).split('\n'), scroll: 0 }, options) }
  choose(title, options, onSelect, index = 0) { this.openModal({ kind: 'select', title, options, index: Math.max(0, Math.min(index, options.length - 1)), onSelect, descriptionScroll: 0 }) }
  form(title, fields, onSubmit) {
    const values = fields.map(f => f.value ?? '')
    this.openModal({ kind: 'form', title, fields, values, carets: values.map(value => [...segments.segment(value)].length), caretValues: [...values], index: 0, onSubmit, error: '' })
  }
  confirm(message, commit, { allowDryRun = true } = {}) {
    this.choose(this.tr('确认变更', 'Confirm change'), [
      { label: this.tr('取消，不保存', 'Cancel — do not save'), run: () => this.closeModal() },
      { label: this.dryRun && allowDryRun ? this.tr('预览，不写入 (dry-run)', 'Preview only (dry-run)') : this.tr('确认执行', 'Confirm'), run: async () => {
        if (this.dryRun && allowDryRun) this.notice = this.tr('dry-run：已预览，未写入。', 'dry-run: previewed; nothing written.')
        else { await commit(); this.notice = this.tr('操作完成。', 'Operation complete.') }
        this.reload()
      } },
    ], option => option.run())
    this.modal.description = message
  }
  async perform(fn, parent = null) {
    try {
      // Preserve the previous dialog only during a synchronous wizard transition.
      // Background completions must not attach unrelated dialogs to this stack.
      const previous = this.transitionModal
      let result
      this.transitionModal = parent
      try { result = fn() } finally { this.transitionModal = previous }
      await result
    } catch {
      // Parser/subprocess errors may contain secrets. Do not echo arbitrary error text.
      this.notice = this.tr('操作失败：配置无效、已变化或宿主拒绝。请刷新并检查对应配置；未假定成功。', 'Operation failed: invalid/changed configuration or host refusal. Reload and inspect the relevant configuration; no success assumed.')
      this.modal = null
      this.reload()
    }
    this.changed()
  }
  keyPatch(patch, message, snapshot = this.services.readKeysFileDocument()) {
    this.confirm(message, () => {
      if (!equal(snapshot, this.services.readKeysFileDocument())) throw new Error('Configuration changed')
      this.services.writeKeysFile(patch)
    })
  }
  editKey(name) {
    const snapshot = this.services.readKeysFileDocument()
    this.form(`${name} · API Key`, [{ label: 'API Key', secret: true, required: true }], ([value]) => this.keyPatch({ [name]: value.trim() }, `${name}: ${this.tr('保存隐藏的 Key；保留其他引擎与路由。', 'Save the hidden key; preserve other engines and routing.')}`, snapshot))
  }
  editUrl(name, base) {
    const snapshot = this.services.readKeysFileDocument()
    this.form(`${name} · Base URL`, [{ label: 'Base URL', value: base, required: true,
      validate: value => normalizeEngineBaseUrl(value) }], ([value]) => this.keyPatch({ baseUrls: { [name]: normalizeEngineBaseUrl(value) } },
      `${value}\n${this.tr('此地址会收到搜索问题和 API Key。请仅使用可信网关。', 'This endpoint receives search queries and API keys. Use trusted gateways only.')}`, snapshot))
  }
  toggleEngine(name) {
    const snapshot = this.services.readKeysFileDocument(), routing = this.services.readKeysRouting()
    if (!routing.keys[name]) throw new Error('No key')
    const enabled = new Set(routing.enabledNames)
    if (enabled.has(name)) enabled.delete(name); else enabled.add(name)
    this.keyPatch({ enabledEngines: [...enabled] }, `${this.tr('API 引擎路由', 'API engine routing')}: ${[...enabled].join(', ') || '(none)'}`, snapshot)
  }
  quotaState(name, routing = this.services.readKeysRouting()) {
    const availability = quotaAvailability(name, routing)
    const cached = this.quotaCache.get(name)
    if (cached && cached.identity !== quotaIdentity(name, routing)) this.quotaCache.delete(name)
    if (availability !== 'idle') return { status: availability, metrics: [] }
    if (this.quotaLoading.has(name)) return { ...(this.quotaCache.get(name)?.result ?? { metrics: [] }), status: 'loading' }
    return this.quotaCache.get(name)?.result ?? { status: 'idle', metrics: [] }
  }
  showQuotaOverview(names = KEY_NAMES, { replace = false } = {}) {
    this.openModal({ kind: 'quota', title: this.tr('API 额度 · 控制台专属', 'API quota · Console only') + (names.length === 1 ? ` · ${names[0]}` : ''), names, scroll: 0 }, { replace: replace || this.modal?.kind === 'quota' })
  }
  requestQuota(names = KEY_NAMES) {
    if (this.quotaTask) { this.notice = this.tr('正在查询额度；Esc 可取消。', 'Quota query in progress; Esc cancels.'); this.changed(); return }
    const routing = this.services.readKeysRouting()
    const targets = names.filter(name => KEY_NAMES.includes(name) && quotaAvailability(name, routing) === 'idle')
    const identities = Object.fromEntries(targets.map(name => [name, quotaIdentity(name, routing)]))
    if (!targets.length) { this.showQuotaOverview(names); return }
    const endpoints = targets.map(name => `${name}: ${QUOTA_PROVIDERS[name].endpoint}`).join('\n')
    this.choose(this.tr('联网查询 API 额度', 'Query API quota online'), [
      { label: this.tr('取消，不联网', 'Cancel — stay offline'), run: () => this.closeModal() },
      { label: this.dryRun ? this.tr('dry-run：预览，不联网', 'dry-run: preview, no network') : targets.includes('brave') ? this.tr('确认查询（Brave 消耗 1 次搜索）', 'Confirm: Brave uses 1 search') : this.tr('确认查询', 'Confirm query'), run: async () => {
        if (this.dryRun) { this.notice = this.tr('dry-run：未查询额度、未发送 Key。', 'dry-run: no quota requests or keys sent.'); return }
        const fresh = this.services.readKeysRouting()
        if (targets.some(name => identities[name] !== quotaIdentity(name, fresh))) throw new Error('Credentials changed; review again')
        await this.queryQuotas(targets, fresh, names)
      } },
    ], option => option.run())
    this.modal.description = [
      ...(targets.includes('brave') ? [this.tr('注意：Brave 会执行 1 次真实搜索，消耗请求配额并可能计费。', 'Warning: Brave executes 1 real search, consuming quota and potentially incurring charges.')] : []),
      ...(targets.includes('tinyfish') ? [this.tr('TinyFish 查询账户钱包，不是剩余搜索次数；不会充值或修改自动充值。', 'TinyFish reads the account wallet, not searches remaining. No top-ups or auto-reload changes.')] : []),
      this.tr('仅向以下官方端点发送对应引擎当前生效的 Key；不写配置、不查询自定义网关。', 'Each effective key goes only to its official endpoint below. No configuration writes or gateway probes.'),
      endpoints,
    ].join('\n')
    this.modal.quotaConsent = true
    this.modal.descriptionScroll = 0
  }
  async queryQuotas(names, routing, overviewNames = names) {
    // Capture credential identity before any asynchronous request or configuration edit.
    routing = { ...routing, keys: { ...routing.keys }, baseUrls: { ...routing.baseUrls } }
    const controller = new AbortController(), task = { controller }
    this.quotaTask = task
    const candidates = names.filter(name => {
      const cached = this.quotaCache.get(name)
      return !cached || cached.identity !== quotaIdentity(name, routing) || this.services.now() >= cached.nextQueryAt
    })
    if (!candidates.length) {
      this.quotaTask = null
      this.notice = this.tr('额度快照已缓存；请至少间隔 60 秒，或等待服务端限流时间。', 'Quota snapshot cached; wait at least 60 seconds, or the provider retry interval.')
      this.showQuotaOverview(overviewNames, { replace: true }); return
    }
    this.quotaLoading = new Set(candidates)
    this.notice = this.tr('正在查询额度 · Esc 取消，Q 退出；不会修改配置。', 'Querying quotas · Esc cancels, Q quits; configuration stays unchanged.')
    this.reload(); this.showQuotaOverview(overviewNames, { replace: true })
    try {
      const outcomes = await Promise.allSettled(candidates.map(async name => {
        const attemptedAt = this.services.now()
        let result
        const identity = quotaIdentity(name, routing), previous = this.quotaCache.get(name)
        this.quotaCache.set(name, { identity, result: previous?.identity === identity ? previous.result : { status: 'idle', metrics: [] }, nextQueryAt: attemptedAt + QUOTA_REFRESH_MS })
        try { result = await this.services.fetchEngineQuota(name, routing, { signal: controller.signal, allowPaidProbe: name === 'brave' }) }
        catch { result = { status: controller.signal.aborted ? 'cancelled' : 'network_error', metrics: [] } }
        this.quotaLoading.delete(name)
        if (controller.signal.aborted || this.closed) return
        const fresh = this.services.readKeysRouting()
        if (quotaIdentity(name, routing) !== quotaIdentity(name, fresh)) return 'changed'
        this.quotaCache.set(name, { identity: quotaIdentity(name, routing), result,
          nextQueryAt: this.services.now() + Math.max(QUOTA_REFRESH_MS, result.retryAfterMs ?? 0) })
        this.reload()
        return result.status
      }))
      const unavailable = outcomes.filter(outcome => outcome.status !== 'fulfilled' || outcome.value !== 'ok').length
      if (!this.closed) this.notice = controller.signal.aborted ? this.tr('额度查询已取消。', 'Quota query cancelled.') : unavailable ? this.tr(`查询结束：${unavailable} 项未取得有效额度，请查看各卡片原因。`, `Query finished: ${unavailable} quota(s) unavailable; inspect each card.`) : this.tr('额度查询完成；时间为查询快照，不自动刷新。', 'Quota query complete; results are timestamped snapshots, not auto-refreshed.')
    } finally {
      if (this.quotaTask === task) this.quotaTask = null
      this.quotaLoading.clear()
      if (!this.closed) this.reload()
    }
  }
  cancelQuota() { this.quotaTask?.controller.abort(); }
  communityChange(platform, change, snapshot) {
    const plan = this.services.planCommunityPlatformChange(platform, change)
    if (snapshot && !equal(snapshot, plan.before)) throw new Error('Community configuration changed')
    if (!plan.changed) { this.notice = this.tr('配置未改变。', 'No changes.'); return }
    this.confirm(`${PLATFORM_NAMES[platform]}: ${change.action}\n${change.backend ? providerLabel(change.backend.provider) + '\n' + JSON.stringify(change.backend.config) : change.id ?? ''}\n${this.tr('只改变此平台，其他平台与凭据保留。', 'Only this platform changes; other platforms and credentials are preserved.')}`,
      () => this.services.applyCommunityPlatformPlan(plan))
  }
  chooseCommunity(platform) {
    const config = this.services.readCommunityConfig()
    const available = communityRegistry.list().filter(p => p.platform === platform)
    const choices = available.flatMap(p => {
      const existing = config.backends.filter(b => b.provider === p.id)
      return (existing.length ? existing : [{ id: `${platform}-console-${p.id}`, provider: p.id, enabled: false, config: {} }]).map(backend => ({
        label: `${backend.enabled ? '● ' : ''}${providerLabel(p.id)} · ${backend.id}`, backend,
      }))
    })
    this.choose(this.tr('选择检索方式', 'Select retrieval source'), choices, ({ backend }) => {
      const cap = communityRegistry.get(backend.provider).describeAvailability({}, backend.config)
      if (backend.provider.endsWith('-browser') && (!backend.config.endpoint || !cap.ready)) {
        this.configureCommunity(platform, backend, 'select', config)
        return
      }
      this.communityChange(platform, { action: 'select', backend }, config)
    }, choices.findIndex(option => option.backend.enabled))
  }
  configureCommunity(platform, backend, mode = 'configure', snapshot = this.services.readCommunityConfig()) {
    if (mode === 'configure') {
      // A page may have been displayed before another UI edited this source.
      // Open the latest saved settings, and never resurrect a deleted instance.
      backend = snapshot.backends.find(row => row.id === backend.id)
      if (!backend) throw new Error('Community instance removed')
    }
    const provider = communityRegistry.get(backend.provider)
    const scopes = value => provider.validateConfig(value.trim() ? { subreddits: value.split(/[,，\s]+/).filter(Boolean).map(v => v.replace(/^r\//i, '')) } : {})
    const fields = backend.provider === 'reddit-arctic' ? [
      { label: this.tr('默认社区（最多 5 个；空=自动发现）', 'Subreddits (up to 5; empty=auto)'), value: backend.config.subreddits?.join(', ') ?? '', validate: scopes },
    ] : [
      { label: this.tr('本地桥地址', 'Local bridge origin'), value: backend.config.endpoint ?? 'http://127.0.0.1:19826', required: true, validate: endpoint => provider.validateConfig({ endpoint, token_env: 'SEARCH_BOOST_BROWSER_TOKEN' }) },
      { label: this.tr('令牌环境变量名（不是令牌）', 'Token env NAME (not the token)'), value: backend.config.token_env ?? 'SEARCH_BOOST_BROWSER_TOKEN', required: true, validate: token_env => provider.validateConfig({ endpoint: 'http://127.0.0.1:19826', token_env }) },
    ]
    this.form(`${PLATFORM_NAMES[platform]} · ${providerLabel(backend.provider)}`, fields, values => {
      const config = backend.provider === 'reddit-arctic' ? scopes(values[0]) : provider.validateConfig({ endpoint: values[0].trim(), token_env: values[1].trim() })
      const missing = backend.provider.endsWith('-browser') && !provider.describeAvailability({}, config).ready
      if (missing && mode === 'select') this.notice = this.tr('令牌环境变量缺失：仅保存配置，不更换当前检索方式。', 'Token environment variable missing: save settings only; current source unchanged.')
      this.communityChange(platform, { action: missing && mode === 'select' ? 'configure' : mode, backend: { ...backend, config } }, snapshot)
      if (missing && this.modal) this.modal.description += '\n' + this.tr('缺少令牌环境变量；仅保存配置，不更换检索方式。', 'Token environment variable missing; save settings only, without changing the source.')
    })
    if (backend.provider.endsWith('-browser')) this.modal.description = `${fileURLToPath(new URL('../browser/community-bridge/', import.meta.url))}\n` + this.tr('手动运行 search-boost community-browser，加载 browser/community-bridge 扩展并明确启用；给宿主设置令牌环境变量。这里不启动浏览器、不读取登录、不输入令牌。', 'Manually run search-boost community-browser, load browser/community-bridge and explicitly enable it; set the token environment variable in the host. No browser launch, login read or token entry here.')
  }
  addJudgment() {
    this.choose(this.tr('选择判断服务', 'Choose judgment service'), ['jev', 'laya'].map(provider => ({ label: provider === 'jev' ? 'Jev (TypeSafe / Vercel)' : 'Laya (self-hosted)', provider })), ({ provider }) => {
      if (provider === 'laya') this.judgmentForm(provider)
      else this.choose(this.tr('选择 Jev 接入', 'Choose Jev destination'), [
        { label: 'TypeSafe · https://api.typesafe.ai/v1', baseUrl: 'https://api.typesafe.ai/v1' },
        { label: 'Vercel AI Gateway · Gateway Key', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
        { label: this.tr('自定义 System One 地址', 'Custom System One URL'), baseUrl: '' },
      ], ({ baseUrl }) => this.judgmentForm(provider, { baseUrl }))
    })
  }
  editJudgment(id) {
    const store = this.services.readJudgmentProfiles()
    this.judgmentForm(store.profiles[id].provider, { id, store })
  }
  judgmentForm(provider, { id, baseUrl, store = this.services.readJudgmentProfiles() } = {}) {
    const existing = id ? store.profiles[id] : null, adapter = decisionRegistry.get(provider)
    let defaultId = baseUrl?.includes('ai-gateway.vercel.sh') ? 'jev-vercel' : provider
    const idBase = defaultId
    for (let n = 2; Object.hasOwn(store.profiles, defaultId); n++) defaultId = `${idBase}-${n}`
    const fields = [
      ...(!id ? [{ label: this.tr('配置名称', 'Profile ID'), value: defaultId, required: true, validate: v => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) || Object.hasOwn(store.profiles, v)) throw new Error('Invalid ID') } }] : []),
      { label: 'Base URL', value: existing?.baseUrl ?? baseUrl ?? adapter.configSchema.baseUrl.default ?? '', required: true, validate: v => decisionRegistry.configurationFor(provider, v) },
      { label: existing ? this.tr('API Key（同址空=保留；Laya -=清除）', 'API Key (same URL: empty=keep; Laya -=clear)') : baseUrl?.includes('ai-gateway.vercel.sh') ? 'Vercel AI Gateway Key' : 'API Key', secret: true, required: !existing && provider === 'jev', validate: value => {
        if (provider === 'jev' && !value && (!existing || normalizeJevBaseUrl(this.modal.values[id ? 0 : 1]) !== existing.baseUrl)) throw new Error('A new destination requires its own key')
      } },
    ]
    this.form(id ? `${this.tr('编辑', 'Edit')} · ${id}` : this.tr('新建判断配置', 'New judgment profile'), fields, values => {
      const [profileId, url, entered] = id ? [id, ...values] : values.map(v => v.trim())
      const destination = decisionRegistry.configurationFor(provider, url)
      const normalizedUrl = provider === 'jev' ? normalizeJevBaseUrl(url) : normalizeDecisionBaseUrl(url)
      const same = existing && existing.baseUrl === normalizedUrl
      const apiKey = provider === 'laya' && entered.trim() === '-' ? null : entered.trim() || (same ? existing.apiKey : null)
      const config = decisionRegistry.validateConfig({ ...(existing?.options ? { options: existing.options } : {}), provider, baseUrl: normalizedUrl, apiKey, authMode: apiKey ? 'bearer' : 'none', model: same ? existing.model : provider === 'laya' ? 'multilingual' : destination.models[0] })
      this.confirm(`${profileId} · ${provider} · ${config.model}\n${destination.endpoint}\n${this.tr('问题、方向和片段发送到此服务；新地址不继承旧 Key。', 'Questions, intent and fragments go here; a new URL never inherits the old key.')}\n${id ? this.tr('仅保存编辑，不切换当前判断配置。', 'Save edits only; do not switch the active profile.') : this.tr('保存并使用此配置。', 'Save and activate this profile.')}\n${provider === 'laya' ? this.tr('Laya 另需离线容量证据。', 'Laya additionally needs offline capacity evidence.') : ''}`, () => {
        if (!equal(store, this.services.readJudgmentProfiles())) throw new Error('Profiles changed')
        this.services.saveJudgmentProfile(profileId, config, { activate: !id })
      })
    })
  }
  async agentOperation(id, uninstall) {
    const opts = { autoAllow: false, replaceNative: false, scope: 'user', skipGrokPlugin: true, dryRun: this.dryRun }
    const next = () => this.confirm(`${AGENTS[id].label}: ${uninstall ? this.tr('移除 SearchBoost 接入', 'Remove SearchBoost integration') : this.tr('安装 SearchBoost 接入', 'Install SearchBoost integration')}\n${opts.profile ? `profile: ${opts.profile}\n` : ''}${id === 'grok' ? this.tr('仅用户级 MCP / 规则 / skill；不修改原生插件。', 'User MCP / rules / skills only; native plugin unchanged.') : this.tr('不改变其他宿主。安装不自动授予工具权限，保留原生搜索。', 'Other hosts are unchanged. Install does not auto-approve tools; keep native search.')}`,
      () => this.runBusy(async () => {
        let dshState
        await this.services.agents[id][uninstall ? 'uninstall' : 'install']({ ...opts, onDshStatus: status => { dshState = status } })
        return dshState?.enabled === false ? this.tr('已安装但宿主禁用了此接入；请在宿主管理器中显式启用。', 'Installed but disabled by the host; explicitly enable it in the host manager.') : this.tr('接入操作完成，请重启 / 重连宿主。', 'Integration operation complete; restart / reconnect the host.')
      }))
    if (id === 'dsh') this.form(this.tr('选择精确 DSH profile', 'Choose exact DSH profile'), [{ label: 'Profile', value: 'web', required: true, validate: value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid profile') } }], ([profile]) => { opts.profile = profile; next() })
    else next()
  }
  async refreshAgent(id) {
    const previousModal = this.modal, previousFocus = this.focus
    this.busy = true
    this.showText(this.tr('正在发现已有接入，请稍候。', 'Discovering existing integrations. Please wait.'), this.tr('正在发现接入', 'Discovering integrations'), { replace: true })
    let plan, integrationTargetKey
    try {
      const integrations = this.services.integrations ?? await import('./upgrade/integrations.mjs')
      integrationTargetKey = integrations.integrationTargetKey
      plan = await integrations.discoverIntegrations()
    } finally {
      this.busy = false; this.modal = previousModal; this.focus = previousFocus
      if (this.exitRequested) this.closed = true
      this.changed()
    }
    if (this.closed) return
    const targets = plan.targets.filter(t => t.id === id)
    if (!targets.length) { this.showText(this.tr('未发现已有接入。请先安装；发现受阻时可使用 search-boost doctor 检查。', 'No existing integration found. Install first; use search-boost doctor if discovery is blocked.')); return }
    this.choose(this.tr('选择精确刷新范围', 'Choose exact refresh scope'), targets.map(target => ({ label: target.label, key: integrationTargetKey(target) })), ({ key, label }) => {
      this.confirm(`${label}\n${this.tr('仅刷新当前包的已有接入，保留权限与禁用状态；不更新 npm 包、不重建 Grok 原生缓存。', 'Refresh only this existing integration from the current package; preserve permissions and disabled state. No npm update or Grok native cache rebuild.')}`, () => this.runBusy(async () => {
        const { runRefresh } = await import('./upgrade/index.mjs')
        const logs = []
        const result = await runRefresh({ selected: [key], dryRun: this.dryRun, log: line => logs.push(line) })
        return [result.ok ? this.tr('刷新完成。', 'Refresh complete.') : this.tr('刷新未完成；不假定成功。', 'Refresh incomplete; no success assumed.'), ...logs].join('\n')
      }), { allowDryRun: false })
    })
  }
  async runBusy(work) {
    this.busy = true
    this.showText(this.tr('正在执行已确认的操作，请稍候。', 'Running the confirmed operation. Please wait.'), this.tr('正在执行', 'Working'), { replace: true })
    try { const text = await work(); this.reload(); this.showText(text, this.tr('操作结果', 'Result'), { replace: true }) }
    finally { this.busy = false; if (this.exitRequested) this.closed = true; this.changed() }
  }
  async doctor() {
    await this.runBusy(async () => {
      const { runDoctor } = await import('./doctor/run.mjs')
      const result = await runDoctor({ quick: true, silent: true })
      return result.text
    })
  }
  chooseTheme() {
    const previous = this.services.readConsoleTheme()
    this.choose(this.tr('选择控制台主题 · Dark', 'Choose console theme · Dark'), Object.values(CONSOLE_THEMES).map(theme => ({ id: theme.id, label: `${theme.label}${theme.id === this.theme ? ' · ●' : ''}` })), option => {
      if (option.id === this.theme) return
      this.confirm(`${consoleTheme(this.theme).label} → ${consoleTheme(option.id).label}\n${this.tr('仅切换控制台配色与 Logo；不改变快速配置 TUI。', 'Change console colors and logo only; the quick TUI is unchanged.')}`, () => {
        this.services.saveConsoleTheme(option.id, { expectedTheme: previous })
        this.theme = option.id
      })
    }, Object.keys(CONSOLE_THEMES).indexOf(this.theme))
  }
  switchLanguage() {
    const next = this.language === 'zh-CN' ? 'en' : 'zh-CN'
    this.confirm(this.tr('将显示语言切换为 English（旧向导也沿用）。', 'Switch display language to 简体中文 (also used by the legacy wizard).'), () => {
      this.services.saveTuiLanguage(next); this.language = next
    })
  }
  handleKey(text, key = {}) {
    if ((key.ctrl && key.name === 'c') || (key.name === 'q' && this.modal?.kind !== 'form')) this.cancelQuota()
    if (key.name === 'escape' && this.quotaTask) { this.cancelQuota(); this.notice = this.tr('正在取消额度查询。', 'Cancelling quota query.'); this.changed(); return }
    if (key.ctrl && key.name === 'c') {
      if (this.busy) { this.exitRequested = true; this.notice = this.tr('操作结束后退出。', 'Will exit after the operation completes.') }
      else { this.closed = true; this.modal = null }
      this.changed(); return
    }
    if (this.busy) return
    const name = key.name, modal = this.modal
    if (name === 'q' && modal?.kind !== 'form') { this.closed = true; this.modal = null; this.changed(); return }
    if (modal) {
      if (name === 'escape' || (name === 'left' && modal.kind !== 'form')) { this.closeModal(); return }
      if (modal.kind === 'quota' && name === 'u') { void this.perform(() => this.requestQuota(modal.names)); return }
      if (modal.kind === 'text' || modal.kind === 'quota') {
        modalPaneBlocks(this, this.viewport.width, this.viewport.height)
        if (name === 'return') this.closeModal()
        else if (name === 'down' || name === 'pagedown' || name === 'j') modal.scroll = Math.min(modal.scrollMax, modal.scroll + (name === 'pagedown' ? modal.pageSize : 1))
        else if (name === 'up' || name === 'pageup' || name === 'k') modal.scroll = Math.max(0, modal.scroll - (name === 'pageup' ? modal.pageSize : 1))
        else if (name === 'home') modal.scroll = 0
        else if (name === 'end') modal.scroll = modal.scrollMax
      } else if (modal.kind === 'select') {
        modalPaneBlocks(this, this.viewport.width, this.viewport.height)
        if (name === 'pagedown' || name === 'pageup') modal.descriptionScroll = Math.max(0, Math.min(modal.descriptionScrollMax ?? 0, modal.descriptionScroll + (name === 'pagedown' ? 1 : -1) * (modal.descriptionPageSize ?? 1)))
        else if (name === 'up' || name === 'down' || name === 'j' || name === 'k') modal.index = Math.max(0, Math.min(modal.options.length - 1, modal.index + (name === 'up' || name === 'k' ? -1 : 1)))
        else if (name === 'tab') modal.index = (modal.index + (key.shift ? -1 : 1) + modal.options.length) % Math.max(1, modal.options.length)
        else if (name === 'home') modal.index = 0
        else if (name === 'end') modal.index = Math.max(0, modal.options.length - 1)
        else if (name === 'return') {
          const option = modal.options[modal.index]; this.closeModal(false, modal)
          if (option) void this.perform(() => modal.onSelect(option), modal)
        }
      } else if (modal.kind === 'form') {
        const count = modal.fields.length + 1
        if ((name === 'pageup' || name === 'pagedown') && modal.description) {
          modalPaneBlocks(this, this.viewport.width, this.viewport.height)
          modal.descriptionScroll = Math.max(0, Math.min(modal.descriptionScrollMax, (modal.descriptionScroll ?? 0) + (name === 'pageup' ? -1 : 1) * modal.descriptionPageSize))
        } else if (name === 'tab') modal.index = (modal.index + (key.shift ? -1 : 1) + count) % count
        else if (name === 'down' || name === 'up') modal.index = Math.max(0, Math.min(count - 1, modal.index + (name === 'up' ? -1 : 1)))
        else if (name === 'return') {
          if (modal.index < modal.fields.length) modal.index++
          else {
            let invalidIndex = 0
            try {
              for (let i = 0; i < modal.fields.length; i++) {
                invalidIndex = i
                const field = modal.fields[i], value = modal.values[i].trim()
                if (field.required && !value) throw new Error('Required')
                field.validate?.(value)
              }
              this.closeModal(false, modal)
              void this.perform(() => modal.onSubmit(modal.values), modal)
            } catch {
              modal.index = invalidIndex
              modal.error = this.tr('必填项为空或格式无效，请检查字段。', 'A required field is empty or invalid. Check the fields.')
            }
          }
        } else if (modal.index < modal.fields.length) {
          const index = modal.index, parts = fieldParts(modal, index)
          let caret = modal.carets[index], next = parts
          if (name === 'left') caret = Math.max(0, caret - 1)
          else if (name === 'right') caret = Math.min(parts.length, caret + 1)
          else if (name === 'home') caret = 0
          else if (name === 'end') caret = parts.length
          else if (name === 'backspace') {
            if (caret > 0) { next = [...parts.slice(0, caret - 1), ...parts.slice(caret)]; caret-- }
          }
          else if (name === 'delete') next = [...parts.slice(0, caret), ...parts.slice(caret + 1)]
          else if (key.ctrl && name === 'u') { next = []; caret = 0 }
          else if (text && !key.ctrl && !key.meta && !['pageup', 'pagedown'].includes(name)) {
            const inserted = [...segments.segment(cleanText(text))].map(part => part.segment)
            next = [...parts.slice(0, caret), ...inserted, ...parts.slice(caret)]; caret += inserted.length
          }
          modal.values[index] = next.join('').slice(0, 4096)
          modal.caretValues[index] = modal.values[index]
          modal.carets[index] = Math.min(caret, [...segments.segment(modal.values[index])].length)
          if (modal.values[index] !== parts.join('')) modal.error = ''

        }
      }
      this.changed(); return
    }
    if (/^[1-8]$/.test(text ?? '')) { this.navigate(Number(text) - 1); return }
    if (text === '?') { this.showText(this.helpLines(), this.tr('快捷键', 'Keyboard shortcuts')); return }
    if (name === 'u' && this.sectionId === 'engines' && this.focus !== 'sidebar') { void this.perform(() => this.requestQuota(this.current?.id === 'quota-overview' ? KEY_NAMES : [this.current.id])); return }
    if (name === 'r') {
      this.notice = this.tr('已重新读取配置。', 'Configuration reloaded.')
      try { this.theme = this.services.readConsoleTheme() } catch { this.notice = this.tr('控制台主题设置不可读；保留当前主题，不覆盖文件。', 'Console theme settings unreadable; keeping the current theme without overwriting the file.') }
      this.reload(); return
    }
    if (name === 'l') { void this.perform(() => this.switchLanguage()); return }
    const panes = ['sidebar', 'list', 'detail'], pane = panes.indexOf(this.focus)
    if (name === 'tab') this.focus = panes[(pane + (key.shift ? -1 : 1) + panes.length) % panes.length]
    else if (name === 'left' || name === 'escape') this.focus = panes[Math.max(0, pane - 1)]
    else if (name === 'right') this.focus = panes[Math.min(panes.length - 1, pane + 1)]
    else if (this.focus === 'detail' && ['up', 'down', 'j', 'k', 'home', 'end', 'pageup', 'pagedown'].includes(name)) {
      detailPaneBlocks(this, this.viewport.width, this.viewport.height)
      const view = this.detailView, actions = this.current?.actions ?? []
      if (name === 'pageup' || name === 'pagedown' || !actions.length) {
        view.scroll = name === 'home' ? 0 : name === 'end' ? view.scrollMax : Math.max(0, Math.min(view.scrollMax, view.scroll + (name === 'up' || name === 'k' || name === 'pageup' ? -1 : 1) * (name === 'pageup' || name === 'pagedown' ? view.pageSize : 1)))
      } else view.actionIndex = name === 'home' ? 0 : name === 'end' ? actions.length - 1 : Math.max(0, Math.min(actions.length - 1, view.actionIndex + (name === 'up' || name === 'k' ? -1 : 1)))
    } else if (name === 'up' || name === 'down' || name === 'j' || name === 'k' || name === 'home' || name === 'end' || name === 'pageup' || name === 'pagedown') {
      const sidebar = this.focus === 'sidebar', count = sidebar ? SECTIONS.length : this.rows.length
      const current = sidebar ? this.section : this.index
      const pageSize = sidebar ? Math.max(1, this.viewport.height - 3) : this.viewport.listPageSize ?? Math.max(1, this.viewport.height - 3)
      const step = name === 'pageup' || name === 'pagedown' ? pageSize : 1
      const next = name === 'home' ? 0 : name === 'end' ? count - 1 : Math.max(0, Math.min(count - 1, current + (name === 'up' || name === 'k' || name === 'pageup' ? -step : step)))
      if (sidebar) this.section = next; else this.selection[this.sectionId] = next
    } else if (name === 'return') {
      if (this.focus === 'sidebar') this.focus = 'list'
      else if (this.focus === 'list') this.focus = 'detail'
      else {
        const selected = this.current?.actions[this.detailView.actionIndex]
        if (selected) void this.perform(() => selected.run())
      }
    } else {
      const id = name === 'space' ? 'toggle' : name === 'e' ? 'edit' : name === 'd' ? 'delete' : null
      const selected = this.focus !== 'sidebar' ? this.current?.actions.find(a => a.id === id) : null
      if (selected) void this.perform(() => selected.run())
    }
    this.changed()
  }
}

const QUOTA_LABELS = {
  idle: ['未查询', 'Not queried'], loading: ['查询中…', 'Querying…'], ok: ['已更新', 'Updated'],
  no_key: ['未配置 Key', 'No key'], custom_gateway: ['网关需手动查看', 'Gateway: manual'],
  service_key_required: ['需服务账号', 'Service key needed'], manual: ['手动查看', 'Manual'], unsupported: ['暂不支持', 'Unsupported'],
  auth_error: ['认证失败', 'Auth failed'], rate_limited: ['查询限流', 'Rate limited'], wallet_unavailable: ['未开通钱包', 'No wallet'],
  http_error: ['服务异常', 'Service error'], invalid_response: ['数据不可识别', 'Unknown response'],
  network_error: ['网络失败', 'Network error'], timeout: ['查询超时', 'Timed out'], cancelled: ['已取消', 'Cancelled'],
}
const QUOTA_NOTES = {
  idle: ['按 U 查询；进入页面不会联网。', 'Press U to query; browsing stays offline.'],
  loading: ['正在读取官方数据，Esc 可取消。', 'Reading official data; Esc cancels.'],
  no_key: ['先配置此引擎的 API Key。', 'Configure this engine’s API key first.'],
  custom_gateway: ['不把网关 Key 发送到官方服务；请在网关查看余额。', 'Gateway keys are not sent to official services. Check your gateway balance.'],
  service_key_required: ['Exa 用量接口需服务账号与 Key ID；不能使用当前搜索 Key 直接查询。', 'Exa usage needs a service account key and key ID, not just the configured search key.'],
  manual: ['暂无已核实的可直接使用的额度接口；请到官方后台查看。', 'No verified direct quota adapter yet; check the official dashboard.'],
  auth_error: ['Key 无效或无此接口权限；不代表余额为零。', 'Invalid key or missing permission; this does not mean a zero balance.'],
  rate_limited: ['服务端限制查询频率；等待后再试，不自动重试。', 'Provider rate limit; wait before retrying. No automatic retries.'],
  wallet_unavailable: ['账户尚未使用钱包计费，不代表搜索余额为零。', 'This account is not on wallet billing; this is not zero search quota.'],
  http_error: ['官方接口返回错误；不推算剩余额度。', 'The provider returned an error; remaining quota is unknown.'],
  invalid_response: ['返回字段与已核实协议不符；不显示猜测数值。', 'Response does not match the verified schema; no guessed numbers.'],
  network_error: ['连接或网络策略失败；未绕过代理策略。', 'Connection or network policy failed; proxy policy is not bypassed.'],
  timeout: ['本次查询超时；未改变 Key 或路由。', 'This query timed out; key and routing unchanged.'],
  cancelled: ['已取消查询，不把部分错误当作余额。', 'Query cancelled; no balance inferred from errors.'],
  independent_limits: ['Key、套餐与按量上限分别展示，不相加；不是可用搜索次数保证。', 'Key, plan and PAYGO ceilings are separate, not additive or guaranteed search counts.'],
  account_wallet_not_search_quota: ['账户共享钱包余额，不是此 Key 的剩余搜索次数。', 'Shared account wallet, not searches remaining for this key.'],
  brave_probe: ['来自 1 次搜索的响应头；长周期请求配额，不是金额余额。', 'From one search response; long-window request quota, not a monetary balance.'],
  no_long_window: ['接口未返回长周期配额；不把每秒限速当作余额。', 'No long-window quota returned; per-second limits are not a balance.'],
}
function quotaCardBlocks(state, tr, width, compact = false) {
  width = Math.max(4, width)
  const inner = width - 4, label = QUOTA_LABELS[state.status] ?? QUOTA_LABELS.unsupported
  const blocks = [{ text: `┌${fitText(` ${state.name ?? ''} · ${tr(...label)} `, width - 2).replace(/ +$/, match => '─'.repeat(match.length))}┐`, style: state.status === 'loading' ? 'accent' : 'muted' }]
  const add = (text, style = 'muted') => {
    for (const part of wrapText(text, inner)) blocks.push({ text: `│ ${fitText(part, inner)} │`, style })
  }
  const format = value => new Intl.NumberFormat(tr('zh-CN', 'en'), { maximumFractionDigits: 6 }).format(value)
  const names = { key: tr('Key 剩余额度', 'Key credits left'), plan: tr('套餐剩余额度', 'Plan credits left'), paygo: tr('按量上限剩余', 'PAYGO headroom'), wallet: tr('账户钱包余额', 'Account wallet'), window: tr('周期剩余请求', 'Window requests left') }
  for (const metric of (compact ? (state.metrics ?? []).slice(0, 1) : state.metrics ?? [])) {
    const ratio = metric.limit > 0 && metric.remaining !== null ? Math.max(0, Math.min(1, metric.remaining / metric.limit)) : null
    const style = metric.remaining !== null && metric.remaining <= 0 ? 'danger' : ratio !== null && ratio <= .1 ? 'danger' : ratio !== null && ratio <= .25 ? 'warn' : 'good'
    const value = metric.unlimited ? tr('此项无上限', 'No cap for this item') : metric.remaining === null ? tr('未提供上限', 'No limit reported') : `${metric.unit === 'USD' ? '$' : ''}${format(metric.remaining)} ${metric.unit}`
    add(`${names[metric.id] ?? metric.id}: ${value}`, style)
    if (ratio !== null) {
      const count = Math.min(18, Math.max(4, inner - 7)), filled = Math.round(ratio * count)
      add(`${'━'.repeat(filled)}${'·'.repeat(count - filled)} ${Math.round(ratio * 100)}%`, style)
    }
    if (!compact && metric.used !== null && metric.used !== undefined) add(`${tr('已用', 'Used')} ${format(metric.used)}${metric.limit !== null ? ` / ${format(metric.limit)}` : ''}`)
    if (!compact && metric.windowSeconds) add(`${tr('周期', 'Window')}: ${format(metric.windowSeconds / 86400)} ${tr('天', 'days')}`)
  }
  const note = QUOTA_NOTES[state.note] ?? QUOTA_NOTES[state.status]
  if (note) {
    if (compact) add(fitText(tr(...note), inner).trimEnd())
    else add(tr(...note))
  }
  if (state.checkedAt !== undefined) {
    const time = new Date(state.checkedAt).toISOString().replace('T', ' ').slice(compact ? 5 : 0, 19)
    add(`${tr('快照', 'Snapshot')}: ${time} UTC`)
  }
  if (!compact && state.providerAsOf) add(`${tr('服务端时间', 'Provider as of')}: ${state.providerAsOf}`)
  if (!compact && ['manual', 'service_key_required', 'wallet_unavailable'].includes(state.status)) add(QUOTA_PROVIDERS[state.name]?.dashboard ?? '')
  blocks.push({ text: `└${'─'.repeat(width - 2)}┘`, style: 'muted' }, { text: '' })
  return blocks
}
function quotaOverviewBlocks(model, width, names = KEY_NAMES) {
  const tr = model.tr.bind(model)
  let routing
  try { routing = model.services.readKeysRouting() } catch { return [{ text: tr('引擎配置不可读；请修复后按 R 刷新。', 'Engine configuration unreadable; repair it and press R.'), style: 'danger' }] }
  if (names.length === 1) return quotaCardBlocks({ name: names[0], ...model.quotaState(names[0], routing) }, tr, width)
  const columns = width >= 78 ? 2 : 1, cardWidth = Math.floor((width - (columns - 1) * 2) / columns)
  const cards = names.map(name => quotaCardBlocks({ name, ...model.quotaState(name, routing) }, tr, cardWidth, true))
  if (columns === 1) return cards.flat()
  const rows = []
  for (let i = 0; i < cards.length; i += 2) {
    const left = cards[i], right = cards[i + 1] ?? []
    for (let j = 0; j < Math.max(left.length, right.length); j++) rows.push({ columns: [left[j], right[j]], cardWidth })
  }
  return rows
}
function detailBlocks(details, width) {
  return details.flatMap((block, index) => wrapText(typeof block === 'string' ? block : block.columns ? block.columns.map(cell => fitText(cell?.text ?? '', block.cardWidth)).join('  ') : block.text, width).map(text => ({ text, style: typeof block === 'string' ? index === 0 ? 'title' : 'muted' : block.style ?? 'muted' })))
}

function fieldParts(modal, index) {
  const value = modal.values[index], parts = [...segments.segment(value)].map(part => part.segment)
  if (modal.caretValues[index] !== value) modal.carets[index] = parts.length
  modal.caretValues[index] = value
  modal.carets[index] = Math.max(0, Math.min(modal.carets[index], parts.length))
  return parts
}
function tailText(text, width) {
  const safe = cleanText(text)
  if (displayWidth(safe) <= width) return safe
  let out = '', used = 1
  for (const { segment } of [...segments.segment(safe)].reverse()) {
    const size = charWidth(segment)
    if (used + size > width) break
    out = segment + out; used += size
  }
  return `…${out}`
}
function detailPaneBlocks(model, width, height) {
  const tr = model.tr.bind(model), current = model.current, view = model.detailView
  const actions = current?.actions ?? [], focused = model.focus === 'detail' && !model.modal
  const actionSpace = actions.length ? Math.min(actions.length, Math.max(1, Math.floor(height * .35))) : 0
  const pageSize = Math.max(1, height - 2 - (actionSpace ? actionSpace + 2 : 1))
  const content = detailBlocks([
    ...(current?.quota ? quotaCardBlocks(current.quota, tr, width, true) : current?.quotaOverview ? quotaOverviewBlocks(model, width) : []),
    ...(current?.details ?? []),
  ], width)
  view.scrollMax = Math.max(0, content.length - pageSize); view.pageSize = pageSize
  view.scroll = Math.min(view.scroll, view.scrollMax)
  view.actionIndex = Math.max(0, Math.min(view.actionIndex, actions.length - 1))
  const out = [{ text: `${focused ? '▸' : ' '} ${tr('详情', 'Details')} · ${current?.label ?? ''}`, style: focused ? 'selected' : 'title' }, { text: '' }, ...content.slice(view.scroll, view.scroll + pageSize)]
  while (out.length < pageSize + 2) out.push({ text: '' })
  out.push({ text: `${tr('PgUp/PgDn 详情', 'PgUp/PgDn details')}${view.scrollMax ? ` · ${view.scroll + 1}/${view.scrollMax + 1}` : ''}`, style: 'muted' })
  if (actionSpace) {
    out.push({ text: `${tr('操作 ↑↓', 'Actions ↑↓')} · ${view.actionIndex + 1}/${actions.length}`, style: 'accent' })
    const start = Math.max(0, view.actionIndex - actionSpace + 1)
    for (let i = start; i < Math.min(actions.length, start + actionSpace); i++) out.push({ text: `${i === view.actionIndex ? '▸' : ' '} ${actions[i].label}`, style: focused && i === view.actionIndex ? 'selected' : i === view.actionIndex ? 'accent' : 'muted' })
  }
  return out.slice(0, height)
}
function modalPaneBlocks(model, width, height) {
  const modal = model.modal, tr = model.tr.bind(model)
  if (!modal) return []
  let out = [{ text: `▸ ${modal.title}`, style: 'selected' }]
  if (modal.description) {
    const lines = wrapText(modal.description, width)
    const room = modal.kind === 'form' ? Math.max(1, Math.min(3, height - 7)) : Math.max(1, height - 5)
    modal.descriptionScrollMax = Math.max(0, lines.length - room)
    modal.descriptionPageSize = room
    modal.descriptionScroll = Math.min(modal.descriptionScroll ?? 0, modal.descriptionScrollMax)
    out.push(...lines.slice(modal.descriptionScroll, modal.descriptionScroll + room).map(text => ({ text, style: 'warn' })))
    if (modal.descriptionScrollMax) out.push({ text: `${modal.descriptionScroll + 1}–${Math.min(lines.length, modal.descriptionScroll + room)}/${lines.length} · PgUp/PgDn`, style: 'accent' })
  }
  if (modal.kind === 'select') {
    out.push({ text: '' })
    const available = Math.max(1, height - out.length), start = Math.max(0, modal.index - available + 1)
    for (let i = start; i < Math.min(modal.options.length, start + available); i++) out.push({ text: `${i === modal.index ? '▸' : ' '} ${modal.options[i].label}`, style: i === modal.index ? 'selected' : 'muted' })
  } else if (modal.kind === 'form') {
    const fields = []
    modal.fields.forEach((field, i) => {
      fields.push({ text: `${i === modal.index ? '▸' : ' '} ${field.label}${field.required ? ' *' : ''}`, style: i === modal.index ? 'accent' : 'muted' })
      const parts = fieldParts(modal, i), visible = field.secret ? parts.map(() => '•') : parts
      if (i === modal.index) {
        const before = visible.slice(0, modal.carets[i]).join(''), after = visible.slice(modal.carets[i]).join('')
        const beforeRoom = Math.max(1, after ? Math.floor((width - 3) * .65) : width - 3)
        const head = tailText(before || (!after ? '…' : ''), beforeRoom)
        fields.push({ text: `  ${head}▏${fitText(after, Math.max(0, width - 3 - displayWidth(head))).trimEnd()}` })
      } else fields.push({ text: `  ${tailText(visible.join('') || '…', Math.max(1, width - 2))}` })
    })
    fields.push({ text: '' }, { text: tr('继续 → 预览与确认', 'Continue → review & confirm'), style: modal.index === modal.fields.length ? 'selected' : 'accent' })
    const error = modal.error ? wrapText(modal.error, width).slice(0, 2).map(text => ({ text, style: 'danger' })) : []
    const room = Math.max(2, height - out.length - error.length)
    const focusLine = modal.index < modal.fields.length ? modal.index * 2 + 1 : fields.length - 1
    const start = Math.max(0, Math.min(fields.length - room, focusLine - room + 1))
    out.push(...fields.slice(start, start + room), ...error)
  } else {
    out.push({ text: '' })
    const content = modal.kind === 'quota' ? detailBlocks(quotaOverviewBlocks(model, width, modal.names), width) : modal.lines.flatMap(text => wrapText(text, width).map(text => ({ text, style: 'muted' })))
    modal.pageSize = Math.max(1, height - out.length - 1)
    modal.scrollMax = Math.max(0, content.length - modal.pageSize)
    modal.scroll = Math.min(modal.scroll, modal.scrollMax)
    out.push(...content.slice(modal.scroll, modal.scroll + modal.pageSize))
    while (out.length < height - 1) out.push({ text: '' })
    out.push({ text: `${tr('↑↓ / PgUp PgDn 滚动', '↑↓ / PgUp PgDn scroll')}${modal.scrollMax ? ` · ${modal.scroll + 1}/${modal.scrollMax + 1}` : ''}`, style: 'accent' })
  }
  return out.slice(0, height)
}
function listPaneBlocks(model, width, height) {
  const out = [{ text: `${model.focus === 'list' ? '▸' : ' '} ${model.title}`, style: model.focus === 'list' ? 'selected' : 'title' }, { text: '' }]
  const available = Math.max(1, height - 3), start = Math.max(0, model.index - available + 1)
  const statusWidth = Math.min(14, Math.floor(width / 3))
  model.rows.slice(start, start + available).forEach((row, offset) => {
    const selected = start + offset === model.index
    out.push({ text: `${selected ? '▸' : ' '} ${fitText(row.label, width - statusWidth - 3)} ${fitText(row.status, statusWidth)}`, style: selected && model.focus === 'list' ? 'selected' : selected ? 'accent' : 'muted' })
  })
  while (out.length < height - 1) out.push({ text: '' })
  out.push({ text: model.tr('Enter / → 进入详情', 'Enter / → details') + ` · ${model.index + 1}/${model.rows.length}`, style: 'accent' })
  return out
}

/** Frame is bounded to columns × (rows - 1), avoiding terminal auto-wrap/scroll. */
export function renderConsole(model, { columns = 100, rows = 30, color = true } = {}) {
  const width = Math.max(0, columns - 1), height = Math.max(1, rows - 1)
  const tr = model.tr.bind(model), line = text => fitText(text, width)
  const paint = (text, style, enabled) => paintConsole(text, style, enabled, model.theme)
  if (columns < 54 || rows < 16) return [line('SearchBoost'), line(tr('终端过小：请调整至至少 54 × 16。', 'Terminal too small: resize to at least 54 × 16.')), line('Q / Ctrl+C → Exit')].slice(0, height).join('\n')
  const innerHeight = height - 7, sidebarWidth = columns >= 80 ? 21 : 16, contentWidth = width - sidebarWidth - 3
  // Dialogs never change the three-pane geometry or replace the item list.
  const detailWidth = columns >= 112 ? Math.floor((contentWidth - 3) * .52) : 0
  const listWidth = contentWidth - (detailWidth ? detailWidth + 3 : 0)
  model.viewport = { width: detailWidth || contentWidth, height: innerHeight, listPageSize: Math.max(1, (detailWidth ? innerHeight : Math.max(4, innerHeight - 6)) - 3) }
  const modal = model.modal, showDetail = Boolean(modal) || model.focus === 'detail'
  const headerWidth = width - 10
  const header = [
    `SearchBoost  /  CONTROL CENTER${model.dryRun ? '  [DRY-RUN]' : ''}`,
    `v${getVersion()} · ${model.title} · ${consoleTheme(model.theme).label}`,
    '─'.repeat(headerWidth),
  ]
  const out = CONSOLE_LOGO.map((row, index) => paint('  ', '0', color) + [...row].map((cell, column) => paint(cell, column < 3 ? 'logoAlt' : 'logo', color)).join('') + paint('  ', '0', color) + paint(fitText(header[index], headerWidth), index === 0 ? 'title' : index === 1 ? 'accent' : 'muted', color))
  const sidebar = SECTIONS.map(([id, zh, en], i) => ({ text: `${i === model.section ? '▸' : ' '} ${i + 1} ${model.language === 'zh-CN' ? zh : en}`, selected: i === model.section }))
  sidebar.push({ text: '' }, { text: tr('  浏览不联网', '  Browse offline') }, { text: '  ?  Help' }, { text: '  Q  Exit' })
  let body, details
  if (detailWidth) {
    body = listPaneBlocks(model, listWidth, innerHeight)
    details = modal ? modalPaneBlocks(model, detailWidth, innerHeight) : detailPaneBlocks(model, detailWidth, innerHeight)
  } else if (showDetail) {
    body = modal ? modalPaneBlocks(model, contentWidth, innerHeight) : detailPaneBlocks(model, contentWidth, innerHeight)
  } else {
    const listHeight = Math.max(4, innerHeight - 6)
    body = listPaneBlocks(model, contentWidth, listHeight)
    body.push({ text: '─'.repeat(contentWidth), style: 'muted' }, ...detailBlocks([model.current?.label ?? '', ...(model.current?.details ?? [])], contentWidth).slice(0, innerHeight - body.length - 1))
  }
  for (let i = 0; i < innerHeight; i++) {
    const side = sidebar[i], main = body[i], detail = details?.[i]
    out.push(paint(fitText(side?.text ?? '', sidebarWidth), side?.selected ? model.focus === 'sidebar' && !modal ? 'selected' : 'accent' : 'muted', color) + paint(' │ ', 'muted', color) +
      paint(fitText(main?.text ?? '', listWidth), main?.style ?? '0', color) +
      (detailWidth ? paint(' │ ', 'muted', color) + paint(fitText(detail?.text ?? '', detailWidth), detail?.style ?? '0', color) : ''))
  }
  let hint
  if (model.busy) hint = tr('  操作进行中 · Ctrl+C 请求完成后退出', '  Operation in progress · Ctrl+C exits after completion')
  else if (modal?.kind === 'form') hint = tr('  Tab 字段  Ctrl+U 清空  PgUp/PgDn 说明  Enter 继续  Esc 返回', '  Tab fields  Ctrl+U clear  PgUp/PgDn info  Enter continue  Esc back')
  else if (modal?.kind === 'select') hint = tr('  ↑↓ / Tab 选择  PgUp/PgDn 说明  Enter 确认  Esc 上一步', '  ↑↓ / Tab select  PgUp/PgDn description  Enter confirm  Esc back')
  else if (modal) hint = tr('  ↑↓ / PgUp PgDn 滚动  Enter / Esc 返回  Q 退出', '  ↑↓ / PgUp PgDn scroll  Enter / Esc back  Q quit')
  else if (model.focus === 'detail') hint = model.current?.actions.length ? tr('  ↑↓ 操作  PgUp/PgDn 详情  Enter 执行  ← / Esc 返回列表', '  ↑↓ actions  PgUp/PgDn details  Enter run  ← / Esc back to list') : tr('  ↑↓ / PgUp/PgDn 滚动详情  ← / Esc 返回列表', '  ↑↓ / PgUp/PgDn scroll details  ← / Esc back to list')
  else hint = tr('  Tab / Shift+Tab 栏切换  ↑↓ 移动  Enter / → 进入详情', '  Tab / Shift+Tab focus  ↑↓ move  Enter / → details')
  if (columns < 80 && !model.busy) {
    if (modal?.kind === 'form') hint = tr('  Esc 返回  Tab 字段  ^U 清空  Enter 继续', '  Esc back  Tab fields  ^U clear  Enter next')
    else if (modal?.kind === 'select') hint = tr('  Esc 返回  ↑↓/Tab 选择  Enter 确认', '  Esc back  ↑↓/Tab select  Enter confirm')
    else if (modal) hint = tr('  Esc 返回  ↑↓ / PgUp PgDn 滚动', '  Esc back  ↑↓ / PgUp PgDn scroll')
    else if (model.focus === 'detail') hint = model.current?.actions.length ? tr('  ↑↓ 操作  PgUp/PgDn 详情  Enter 执行  Esc 列表', '  ↑↓ actions  PgUp/PgDn details  Enter run  Esc list') : tr('  ↑↓ / PgUp/PgDn 滚动  Esc 列表', '  ↑↓ / PgUp/PgDn scroll  Esc list')
    else hint = tr('  Enter/→ 详情  Esc 返回  Tab 切栏', '  Enter/→ details  Esc back  Tab focus')
  }
  let footer
  if (model.busy) footer = tr('  请等待操作结束；不会中断配置写入。', '  Please wait; configuration writes will not be interrupted.')
  else if (modal) footer = modal.kind === 'quota' ? tr('  U 查询额度  Esc 取消查询 / 返回  Ctrl+C 退出', '  U query quota  Esc cancel / back  Ctrl+C quit') : tr('  PgUp/PgDn 说明  未确认不保存  Ctrl+C 退出', '  PgUp/PgDn info  No writes before consent  Ctrl+C quit')
  else if (columns < 112) footer = tr('  ? 帮助  Q 退出  ≥112 列同时显示三栏', '  ? help  Q quit  ≥112 columns shows all three panes')
  else {
    const ids = model.focus === 'sidebar' ? [] : model.current?.actions.map(action => action.id) ?? []
    const shortcuts = [
      ...(ids.includes('edit') ? [tr('E 编辑', 'E edit')] : []),
      ...(ids.includes('toggle') ? [tr('Space 开关', 'Space toggle')] : []),
      ...(ids.includes('delete') ? [tr('D 删除', 'D delete')] : []),
      ...(model.sectionId === 'engines' && model.focus !== 'sidebar' ? [tr('U 额度', 'U quota')] : []),
      tr('1–8 分类', '1–8 sections'), tr('R 刷新', 'R reload'), tr('L 语言', 'L language'), tr('? 帮助', '? help'), tr('Q 退出', 'Q quit'),
    ]
    footer = `  ${shortcuts.join('  ')}`
  }

  out.push(paint('─'.repeat(width), 'muted', color), paint(line(`  ${model.notice || tr('就绪 · 配置就绪不代表实时连通', 'Ready · configuration readiness is not live connectivity')}`), model.notice ? 'warn' : 'muted', color),
    paint(line(hint), 'accent', color),
    paint(line(footer), 'muted', color))
  return out.slice(0, height).join('\n')
}

export const consoleHelp = `Usage: search-boost tui [--dry-run] [--no-color] [--preview]\n\nIndependent full-screen console (the no-argument command keeps the legacy TUI).\n  --dry-run   Preview configuration changes without writing\n  --no-color  Disable colors, retain terminal layout\n  --preview   Print a read-only snapshot without requiring a TTY\n  --help      Show this help\n\nTab / Shift+Tab: three-pane focus · arrows / J K: navigate · 1–8: sections\nEnter: list → details / run action · PgUp / PgDn: scroll details\nE: edit · U: engine quotas (explicit network consent) · Space: toggle · D: delete · R: reload · L: language\n?: help · Esc: cancel/back · Q / Ctrl+C: quit\n`

export async function runConsoleTui(args = [], { input = process.stdin, output = process.stdout, model: suppliedModel } = {}) {
  const allowed = new Set(['--dry-run', '--no-color', '--preview', '--help', '-h'])
  if (args.some(arg => !allowed.has(arg))) throw new Error('Usage: search-boost tui [--dry-run] [--no-color] [--preview] [--help]')
  if (args.includes('--help') || args.includes('-h')) { output.write(consoleHelp); return }
  if (!args.includes('--preview') && (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')) {
    throw new Error('search-boost tui requires an interactive terminal. Use --preview for a read-only snapshot, or search-boost for the legacy TUI.')
  }
  const model = suppliedModel ?? new ConsoleModel({ dryRun: args.includes('--dry-run') })
  const color = !args.includes('--no-color') && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
  if (args.includes('--preview')) {
    output.write(renderConsole(model, { columns: output.columns ?? 100, rows: output.rows ?? 30, color: false }) + '\n')
    return
  }
  const wasRaw = Boolean(input.isRaw), wasPaused = input.isPaused(), priorChange = model.onChange
  await new Promise((resolve, reject) => {
    let ended = false
    const cleanup = error => {
      if (ended) return
      ended = true
      model.cancelQuota()
      input.off('keypress', onKey); input.off('end', onEnd); input.off('error', onError)
      output.off('resize', draw); output.off('error', onError); process.off('SIGTERM', onEnd); process.off('SIGHUP', onEnd); process.off('SIGINT', onInterrupt)
      model.onChange = priorChange
      try { input.setRawMode(wasRaw); if (wasPaused) input.pause(); output.write(`${RESET}${ESC}?25h${ESC}?1049l`) } catch { /* terminal may already be disconnected */ }
      if (error) reject(error); else resolve()
    }
    const draw = () => {
      if (ended) return
      if (model.closed) { cleanup(); return }
      try { output.write(`${ESC}H${renderConsole(model, { columns: output.columns ?? 100, rows: output.rows ?? 30, color }).replaceAll('\n', '\r\n')}${ESC}J`) } catch (error) { cleanup(error) }
    }
    const onKey = (text, key) => { try { model.handleKey(text, key) } catch (error) { cleanup(error) } }
    const onEnd = () => cleanup()
    const onInterrupt = () => model.handleKey('', { ctrl: true, name: 'c' })
    const onError = error => cleanup(error)
    try {
      emitKeypressEvents(input)
      input.setRawMode(true); input.resume()
      input.on('keypress', onKey); input.once('end', onEnd); input.once('error', onError)
      output.on('resize', draw); output.once('error', onError); process.once('SIGTERM', onEnd); process.once('SIGHUP', onEnd); process.on('SIGINT', onInterrupt)
      model.onChange = draw
      output.write(`${ESC}?1049h${ESC}?25l`)
      draw()
    } catch (error) { cleanup(error) }
  })
}
