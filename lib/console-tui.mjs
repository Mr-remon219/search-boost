/** Independent full-screen console. No Clack prompts or legacy TUI navigation. */
import { emitKeypressEvents } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { KEY_NAMES, ENV_MAP, readKeys, readKeysFileDocument, readKeysRouting, writeKeysFile, envKeySet } from './keys.mjs'
import { ENGINE_BASE_URLS, normalizeEngineBaseUrl } from './engine-endpoints.mjs'
import { getLayer, setLayer } from './layer-config.mjs'
import { toolStates, saveToolPreferences } from './tool-config.mjs'
import { communityCapabilities, readCommunityConfig, communityRegistry, planCommunityPlatformChange, applyCommunityPlatformPlan } from './community/config.mjs'
import { readJudgmentProfiles, saveJudgmentProfile, activateJudgmentProfile, removeJudgmentProfile } from './judgment/config.mjs'
import { decisionRegistry } from './judgment/registry.mjs'
import { AGENTS, AGENT_IDS, agentStatus } from './agents/index.mjs'
import { readPiAuth, importApiKey, logout as logoutX } from './search/x/xauth.js'
import { readTuiSettings, saveTuiLanguage, systemLanguage } from './installer/i18n.mjs'
import { searchBoostHome } from './config-paths.mjs'
import { getVersion } from './pkg.mjs'

const ESC = '\x1b['
const RESET = `${ESC}0m`
const palette = { muted: '90', accent: '96', good: '92', warn: '93', danger: '91', title: '1;97', selected: '1;30;106' }
const paint = (text, style, color) => color ? `${ESC}${palette[style] ?? style}m${text}${RESET}` : text
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
  constructor({ dryRun = false, language, services = {} } = {}) {
    this.services = { readKeys, readKeysFileDocument, readKeysRouting, writeKeysFile, envKeySet,
      getLayer, setLayer, toolStates, saveToolPreferences, communityCapabilities, readCommunityConfig,
      planCommunityPlatformChange, applyCommunityPlatformPlan, readJudgmentProfiles, saveJudgmentProfile,
      activateJudgmentProfile, removeJudgmentProfile, agentStatus, saveTuiLanguage, readPiAuth, importApiKey, logoutX, agents: AGENTS, ...services }
    this.dryRun = dryRun
    this.section = 0; this.selection = {}; this.focus = 'list'; this.modal = null
    this.notice = ''; this.busy = false; this.closed = false; this.onChange = () => {}
    try { this.language = language ?? readTuiSettings().language } catch {
      this.language = language ?? systemLanguage()
      this.notice = this.tr('显示设置不可读；不会覆盖损坏文件。', 'Display settings unreadable; damaged files will not be overwritten.')
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
      return KEY_NAMES.map(name => {
        const configured = Boolean(routing.keys[name]), enabled = routing.enabledNames.includes(name)
        const source = typeof doc[name] === 'string' && doc[name].trim() ? 'file' : configured ? 'env' : 'missing'
        const base = routing.baseUrls[name]
        return item(name, name, configured ? enabled ? tr('已启用', 'Enabled') : tr('已停用', 'Disabled') : tr('未配置', 'No key'), [
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
        ])
      })
    })
    safePage('search', () => ['free', 'api'].map(layer => item(layer, layer.toUpperCase(), s.getLayer() === layer ? tr('当前', 'Active') : '—', [
      layer === 'free' ? tr('无需 Key：bing / ddg / exa-free / anysearch。', 'Keyless engines: bing / ddg / exa-free / anysearch.') : tr('使用已配置的 API 引擎；无 Key 时回退免费引擎。', 'Use configured API engines; fall back to free engines when no keys are available.'),
      tr('影响默认搜索层，不修改引擎凭据或单次请求参数。', 'Changes the default layer, not credentials or per-request parameters.'),
    ], [action('activate', tr('设为默认', 'Use as default'), () => this.confirm(`${tr('默认搜索层', 'Default layer')}: ${layer}`, () => s.setLayer(layer)))])))
    safePage('tools', () => s.toolStates().map(row => item(row.name, row.name, row.locked ? tr('待配置', 'Locked') : row.enabled ? tr('已启用', 'Enabled') : tr('已停用', 'Disabled'), [row.hint, row.reason,
      tr('只控制工具入口，不等同于内部引擎权限。宿主可能需要重启 / 重连。', 'Controls tool entries, not internal engine permissions. Hosts may need a restart / reconnect.'),
    ], row.locked ? [] : [action('toggle', tr('切换开关', 'Toggle'), () => this.confirm(`${row.name} → ${row.enabled ? 'OFF' : 'ON'}`, () => s.saveToolPreferences({ [row.name]: !row.enabled })))])))
    safePage('community', () => {
      const cap = s.communityCapabilities()
      if (cap.error) throw new Error('Unreadable community store')
      return cap.platforms.map(({ platform }) => {
        const backends = cap.backends.filter(b => b.platform === platform), active = backends.filter(b => b.enabled)
        return item(platform, PLATFORM_NAMES[platform], active.length ? active.some(b => b.ready) ? tr('已启用', 'Enabled') : tr('待配置', 'Needs setup') : tr('已停用', 'Disabled'), [
          ...backends.map(b => `${b.enabled ? '●' : '○'} ${providerLabel(b.provider)} · ${b.id}${b.enabled && !b.ready ? ` · ${b.reason}` : ''}`),
          tr('仅配置就绪状态，不验证网络、浏览器登录或检索覆盖率。', 'Configuration readiness only, not connectivity, browser login or coverage.'),
          tr('浏览器接入等高级参数仍可通过 community_backend 管理。', 'Advanced parameters such as browser connection can be managed with community_backend.'),
        ], [action('edit', tr('选择检索方式', 'Select retrieval source'), () => this.chooseCommunity(platform)),
          ...(active.length ? [action('toggle', tr('停用此平台', 'Disable platform'), () => this.communityChange(platform, { action: 'disable' }))] : []),
          ...(platform === 'x' ? [action('credential', tr('设置 xAI API Key', 'Set xAI API key'), () => this.form('X · xAI API Key', [{ label: 'API Key', secret: true, required: true, validate: value => { if (!value.startsWith('xai-')) throw new Error('Invalid xAI key') } }], ([value]) => this.confirm(tr('保存本地 xAI Key；不改变平台启停状态。', 'Save the local xAI key; platform enablement is unchanged.'), () => s.importApiKey(value)))),
            ...(s.readPiAuth() ? [action('delete', tr('移除本地 X 凭据', 'Remove local X credentials'), () => this.confirm(tr('只移除本地副本；Grok 登录和环境变量保持不变。', 'Remove only the local copy; Grok login and environment credentials are unchanged.'), () => s.logoutX()))] : [])] : [])])
      })
    })
    safePage('judgment', () => {
      const store = s.readJudgmentProfiles()
      return [item('new', tr('添加判断模型', 'Add judgment profile'), 'Jev / Laya', [
        tr('专用判断服务；普通搜索不需要配置。', 'Dedicated judgment services; ordinary search does not require one.'),
        tr('问题、方向与必要材料片段将发送到指定服务；引擎 Key 不会发送。', 'Questions, intent and necessary fragments go to the configured service; engine keys do not.'),
      ], [action('edit', tr('新建配置', 'New profile'), () => this.addJudgment())]),
      ...Object.entries(store.profiles).filter(([, p]) => p.provider !== 'jev' || p.apiKey).map(([id, p]) => item(id, id, store.activeProfile === id ? tr('当前', 'Active') : p.provider, [
        `${p.provider} · ${p.model}`, `Base URL: ${p.baseUrl}`, `Auth: ${p.authMode} · ${p.apiKey ? '••••••••' : 'none'}`,
        ...(p.provider === 'laya' ? [tr('Laya 需要离线容量证据；保存配置不保证判断可用。', 'Laya requires offline capacity evidence; saving does not guarantee judgment availability.')] : []),
        tr('切换模型会改变材料发送目的地。', 'Switching profiles changes the destination for judgment material.'),
      ], [action('activate', tr('使用此配置', 'Activate profile'), () => this.confirm(`${id}: ${p.baseUrl}`, () => s.activateJudgmentProfile(id))),
        action('delete', tr('删除配置与 Key', 'Delete profile and key'), () => this.confirm(tr(`删除 ${id}；删除当前配置后不会自动选择其他目的地。`, `Delete ${id}; deleting the active profile does not select another destination.`), () => s.removeJudgmentProfile(id)))]))]
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
    this.pages = pages
    this.changed()
  }
  helpLines() {
    return [this.tr('↑ / ↓ 或 J / K：移动当前列表', '↑ / ↓ or J / K: move through the focused list'),
      this.tr('Tab / Shift+Tab：切换侧栏与列表', 'Tab / Shift+Tab: switch sidebar / list focus'),
      this.tr('← / →：侧栏 / 列表；1–8：跳转分类', '← / →: sidebar / list; 1–8: jump to a section'),
      this.tr('Enter：操作菜单；Space：切换可切换项（需确认）', 'Enter: action menu; Space: toggle when supported (confirmation required)'),
      this.tr('E：编辑；D：删除；R：重新读取配置', 'E: edit; D: delete; R: reload configuration'),
      this.tr('?：帮助；L：语言；Esc：关闭弹窗 / 返回侧栏', '?: help; L: language; Esc: close dialog / return to sidebar'),
      this.tr('弹窗 ↑↓ 选择，Enter 提交；默认取消，Esc 不保存', 'Dialogs: ↑↓ select, Enter submit; cancel is the default, Esc discards'),
      this.tr('Q / Ctrl+C：退出；输入框内 Q 是普通文本', 'Q / Ctrl+C: quit; Q inside a text field is ordinary text'),
      this.tr('忙碌时 Ctrl+C 请求操作完成后退出，避免中断配置写入', 'While busy, Ctrl+C requests exit after completion to avoid interrupting writes')]
  }
  navigate(index) { this.section = index; this.focus = 'list'; this.modal = null; this.changed() }
  showText(text, title = this.tr('详情', 'Details')) { this.modal = { kind: 'text', title, lines: Array.isArray(text) ? text : String(text).split('\n'), scroll: 0 }; this.changed() }
  choose(title, options, onSelect) { this.modal = { kind: 'select', title, options, index: 0, onSelect }; this.changed() }
  form(title, fields, onSubmit) {
    this.modal = { kind: 'form', title, fields, values: fields.map(f => f.value ?? ''), index: 0, onSubmit, error: '' }
    this.changed()
  }
  confirm(message, commit, { allowDryRun = true } = {}) {
    this.choose(this.tr('确认变更', 'Confirm change'), [
      { label: this.tr('取消，不保存', 'Cancel — do not save'), run: () => {} },
      { label: this.dryRun && allowDryRun ? this.tr('预览，不写入 (dry-run)', 'Preview only (dry-run)') : this.tr('确认执行', 'Confirm'), run: async () => {
        if (this.dryRun && allowDryRun) this.notice = this.tr('dry-run：已预览，未写入。', 'dry-run: previewed; nothing written.')
        else { await commit(); this.notice = this.tr('操作完成。', 'Operation complete.') }
        this.reload()
      } },
    ], option => option.run())
    this.modal.description = message
  }
  async perform(fn) {
    try { await fn() } catch {
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
  communityChange(platform, change) {
    const plan = this.services.planCommunityPlatformChange(platform, change)
    if (!plan.changed) { this.notice = this.tr('配置未改变。', 'No changes.'); return }
    this.confirm(`${PLATFORM_NAMES[platform]}: ${change.action}\n${change.backend ? providerLabel(change.backend.provider) : ''}\n${this.tr('只改变此平台，其他平台与凭据保留。', 'Only this platform changes; other platforms and credentials are preserved.')}`,
      () => this.services.applyCommunityPlatformPlan(plan))
  }
  chooseCommunity(platform) {
    const config = this.services.readCommunityConfig()
    const available = communityRegistry.list().filter(p => p.platform === platform)
    const choices = available.flatMap(p => {
      const existing = config.backends.filter(b => b.provider === p.id)
      return (existing.length ? existing : [{ id: `${platform}-console-${p.id}`, provider: p.id, enabled: false, config: {} }]).map(backend => ({
        label: `${providerLabel(p.id)} · ${backend.id}`, backend,
      }))
    })
    this.choose(this.tr('选择检索方式', 'Select retrieval source'), choices, ({ backend }) => {
      const cap = communityRegistry.get(backend.provider).describeAvailability({}, backend.config)
      if (backend.provider.endsWith('-browser') && !cap.ready) {
        this.showText(this.tr('浏览器方式需要用户主动配置本地桥与令牌环境变量名。请先使用 community_backend 配置，或使用网页索引。本控制台不启动浏览器、不读取登录会话、不绕过验证。', 'Browser retrieval requires an explicitly configured local bridge and token environment name. Configure it with community_backend first, or use web index. This console does not launch browsers, read login sessions or bypass challenges.'))
        return
      }
      this.communityChange(platform, { action: 'select', backend })
    })
  }
  addJudgment() {
    this.choose(this.tr('选择判断模型', 'Choose judgment provider'), ['jev', 'laya'].map(provider => ({ label: provider === 'jev' ? 'Jev (TypeSafe / Vercel)' : 'Laya (self-hosted)', provider })), ({ provider }) => {
      const store = this.services.readJudgmentProfiles(), adapter = decisionRegistry.get(provider)
      this.form(this.tr('新建判断模型配置', 'New judgment profile'), [
        { label: this.tr('配置名称', 'Profile ID'), value: provider, required: true, validate: v => { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) || Object.hasOwn(store.profiles, v)) throw new Error('Invalid or duplicate ID') } },
        { label: 'Base URL', value: adapter.configSchema.baseUrl.default ?? '', required: true, validate: v => decisionRegistry.configurationFor(provider, v) },
        { label: 'API Key', secret: true, required: provider === 'jev' },
      ], ([id, baseUrl, key]) => {
        const destination = decisionRegistry.configurationFor(provider, baseUrl)
        const config = decisionRegistry.validateConfig({ provider, baseUrl, apiKey: key.trim() || null, authMode: key.trim() ? 'bearer' : 'none', model: provider === 'laya' ? 'multilingual' : destination.models[0] })
        this.confirm(`${id} · ${provider}\n${destination.endpoint}\n${this.tr('问题、方向和材料片段将发送至此服务。Laya 另需离线容量证据。', 'Questions, intent and fragments go to this service. Laya additionally requires offline capacity evidence.')}`, () => {
          if (!equal(store, this.services.readJudgmentProfiles())) throw new Error('Profiles changed')
          this.services.saveJudgmentProfile(id, config)
        })
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
    this.busy = true; this.changed()
    let plan, integrationTargetKey
    try {
      const integrations = await import('./upgrade/integrations.mjs')
      integrationTargetKey = integrations.integrationTargetKey
      plan = await integrations.discoverIntegrations()
    } finally {
      this.busy = false
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
    this.busy = true; this.modal = { kind: 'text', title: this.tr('正在执行', 'Working'), lines: [this.tr('正在执行已确认的操作，请稍候。', 'Running the confirmed operation. Please wait.')], scroll: 0 }; this.changed()
    try { const text = await work(); this.reload(); this.showText(text, this.tr('操作结果', 'Result')) }
    finally { this.busy = false; if (this.exitRequested) this.closed = true; this.changed() }
  }
  async doctor() {
    await this.runBusy(async () => {
      const { runDoctor } = await import('./doctor/run.mjs')
      const result = await runDoctor({ quick: true, silent: true })
      return result.text
    })
  }
  switchLanguage() {
    const next = this.language === 'zh-CN' ? 'en' : 'zh-CN'
    this.confirm(this.tr('将显示语言切换为 English（旧向导也沿用）。', 'Switch display language to 简体中文 (also used by the legacy wizard).'), () => {
      this.services.saveTuiLanguage(next); this.language = next
    })
  }
  handleKey(text, key = {}) {
    if (key.ctrl && key.name === 'c') {
      if (this.busy) { this.exitRequested = true; this.notice = this.tr('操作结束后退出。', 'Will exit after the operation completes.') }
      else { this.closed = true; this.modal = null }
      this.changed(); return
    }
    if (this.busy) return
    const name = key.name, modal = this.modal
    if (name === 'q' && modal?.kind !== 'form') { this.closed = true; this.modal = null; this.changed(); return }
    if (modal) {
      if (name === 'escape') { this.modal = null; this.changed(); return }
      if (modal.kind === 'text') {
        if (name === 'return') this.modal = null
        else if (name === 'down' || name === 'pagedown') modal.scroll = Math.min(Math.max(0, modal.lines.join('\n').length), modal.scroll + (name === 'pagedown' ? 8 : 1))
        else if (name === 'up' || name === 'pageup') modal.scroll = Math.max(0, modal.scroll - (name === 'pageup' ? 8 : 1))
      } else if (modal.kind === 'select') {
        if (name === 'up' || name === 'down') modal.index = (modal.index + (name === 'up' ? -1 : 1) + modal.options.length) % modal.options.length
        else if (name === 'return') {
          const option = modal.options[modal.index]; this.modal = null
          if (option) void this.perform(() => modal.onSelect(option))
        }
      } else if (modal.kind === 'form') {
        const count = modal.fields.length + 1
        if (name === 'tab' || name === 'down' || name === 'up') {
          modal.index = (modal.index + (key.shift || name === 'up' ? -1 : 1) + count) % count
        } else if (name === 'return') {
          if (modal.index < modal.fields.length) modal.index++
          else {
            try {
              for (let i = 0; i < modal.fields.length; i++) {
                const field = modal.fields[i], value = modal.values[i].trim()
                if (field.required && !value) throw new Error('Required')
                field.validate?.(value)
              }
              this.modal = null
              void this.perform(() => modal.onSubmit(modal.values))
            } catch { modal.error = this.tr('必填项为空或格式无效，请检查字段。', 'A required field is empty or invalid. Check the fields.') }
          }
        } else if (modal.index < modal.fields.length) {
          if (name === 'backspace') modal.values[modal.index] = [...segments.segment(modal.values[modal.index])].slice(0, -1).map(s => s.segment).join('')
          else if (key.ctrl && name === 'u') modal.values[modal.index] = ''
          else if (text && !key.ctrl && !key.meta) modal.values[modal.index] = (modal.values[modal.index] + cleanText(text)).slice(0, 4096)
        }
      }
      this.changed(); return
    }
    if (/^[1-8]$/.test(text ?? '')) { this.navigate(Number(text) - 1); return }
    if (text === '?') { this.showText(this.helpLines(), this.tr('快捷键', 'Keyboard shortcuts')); return }
    if (name === 'r') { this.notice = this.tr('已重新读取配置。', 'Configuration reloaded.'); this.reload(); return }
    if (name === 'l') { void this.perform(() => this.switchLanguage()); return }
    if (name === 'tab') this.focus = this.focus === 'sidebar' ? 'list' : 'sidebar'
    else if (name === 'left' || name === 'escape') this.focus = 'sidebar'
    else if (name === 'right') this.focus = 'list'
    else if (name === 'up' || name === 'down' || name === 'j' || name === 'k' || name === 'home' || name === 'end') {
      const sidebar = this.focus === 'sidebar', count = sidebar ? SECTIONS.length : this.rows.length
      const current = sidebar ? this.section : this.index
      const next = name === 'home' ? 0 : name === 'end' ? count - 1 : (current + (name === 'up' || name === 'k' ? -1 : 1) + count) % count
      if (sidebar) this.section = next; else this.selection[this.sectionId] = next
    } else if (name === 'return') {
      if (this.focus === 'sidebar') this.focus = 'list'
      else if (this.current?.actions.length) this.choose(this.current.label, this.current.actions, a => a.run())
      else if (this.current) this.showText(this.current.details, this.current.label)
    } else {
      const id = name === 'space' ? 'toggle' : name === 'e' ? 'edit' : name === 'd' ? 'delete' : null
      const selected = this.focus === 'list' ? this.current?.actions.find(a => a.id === id) : null
      if (selected) void this.perform(() => selected.run())
    }
    this.changed()
  }
}

/** Frame is bounded to columns × (rows - 1), avoiding terminal auto-wrap/scroll. */
export function renderConsole(model, { columns = 100, rows = 30, color = true } = {}) {
  const width = Math.max(0, columns - 1), height = Math.max(1, rows - 1)
  const tr = model.tr.bind(model), line = text => fitText(text, width)
  if (columns < 54 || rows < 16) return [line('SearchBoost'), line(tr('终端过小：请调整至至少 54 × 16。', 'Terminal too small: resize to at least 54 × 16.')), line('Q / Ctrl+C → Exit')].slice(0, height).join('\n')
  const innerHeight = height - 7, sidebarWidth = columns >= 80 ? 21 : 16, contentWidth = width - sidebarWidth - 3
  const detailWidth = columns >= 112 && !model.modal ? Math.min(42, Math.floor(contentWidth * .46)) : 0
  const listWidth = contentWidth - (detailWidth ? detailWidth + 3 : 0)
  const out = [paint(line(`  SEARCHBOOST  /  CONTROL CENTER${model.dryRun ? '  [DRY-RUN]' : ''}`), 'title', color),
    paint(line(`  v${getVersion()}  ·  ${tr('独立控制台', 'Independent console')}  ·  ${model.title}`), 'accent', color),
    paint('─'.repeat(width), 'muted', color)]
  const sidebar = SECTIONS.map(([id, zh, en], i) => ({ text: `${i === model.section ? '▸' : ' '} ${i + 1} ${model.language === 'zh-CN' ? zh : en}`, selected: i === model.section }))
  sidebar.push({ text: '' }, { text: tr('  本地配置 · 无联网', '  Local · offline') }, { text: '  ?  Help' }, { text: '  Q  Exit' })
  let body = [], details = []
  const modal = model.modal
  if (modal) {
    body.push({ text: modal.title, style: 'title' })
    if (modal.description) for (const text of wrapText(modal.description, listWidth).slice(0, Math.max(1, innerHeight - 5))) body.push({ text, style: 'warn' })
    body.push({ text: '' })
    if (modal.kind === 'select') {
      const available = Math.max(1, innerHeight - body.length - 1), start = Math.max(0, modal.index - available + 1)
      for (let i = start; i < Math.min(modal.options.length, start + available); i++) body.push({ text: `${i === modal.index ? '▸' : ' '} ${modal.options[i].label}`, style: i === modal.index ? 'selected' : null })
    } else if (modal.kind === 'form') {
      modal.fields.forEach((field, i) => {
        body.push({ text: `${i === modal.index ? '▸' : ' '} ${field.label}${field.required ? ' *' : ''}`, style: i === modal.index ? 'accent' : 'muted' })
        const value = field.secret ? '•'.repeat(Math.min(32, [...modal.values[i]].length)) : modal.values[i]
        body.push({ text: `  ${value || '…'}${i === modal.index ? ' ▏' : ''}` })
      })
      body.push({ text: '' }, { text: tr('继续 → 预览与确认', 'Continue → review & confirm'), style: modal.index === modal.fields.length ? 'selected' : 'accent' })
      if (modal.error) body.push({ text: modal.error, style: 'danger' })
      // Keep the focused input/submit visible even in a short terminal.
      if (body.length > innerHeight) {
        const focusLine = modal.index < modal.fields.length ? 3 + modal.index * 2 : 3 + modal.fields.length * 2 + 1
        const start = Math.max(1, focusLine - innerHeight + 3)
        body = [body[0], ...body.slice(start, start + innerHeight - 1)]
      }
    } else {
      const wrapped = modal.lines.flatMap(text => wrapText(text, listWidth))
      const start = Math.min(modal.scroll, Math.max(0, wrapped.length - Math.max(1, innerHeight - body.length)))
      body.push(...wrapped.slice(start).map(text => ({ text })))
    }
    details = [tr('当前操作', 'Current operation'), '', tr('Esc 取消 / 关闭', 'Esc cancel / close'), tr('Enter 继续 / 确认', 'Enter continue / confirm'), '', tr('未确认不保存。密钥不会显示。', 'No writes before confirmation. Keys are hidden.')]
  } else {
    body.push({ text: model.title, style: 'title' }, { text: '' })
    const listSpace = Math.max(1, innerHeight - 3 - (detailWidth ? 0 : 6))
    const start = Math.max(0, model.index - listSpace + 1)
    model.rows.slice(start, start + listSpace).forEach((row, offset) => {
      const selected = start + offset === model.index
      const statusWidth = Math.min(14, Math.floor(listWidth / 3))
      body.push({ text: `${selected ? '▸' : ' '} ${fitText(row.label, listWidth - statusWidth - 3)} ${fitText(row.status, statusWidth)}`, style: selected && model.focus === 'list' ? 'selected' : selected ? 'accent' : null })
    })
    if (model.rows.length > listSpace) body.push({ text: `${model.index + 1} / ${model.rows.length}`, style: 'muted' })
    details = [model.current?.label ?? '', '', ...(model.current?.details ?? []), '', ...((model.current?.actions ?? []).map(a => `› ${a.label}`))]
    if (!detailWidth) {
      body.push({ text: '' }, { text: '─'.repeat(listWidth), style: 'muted' })
      const remaining = innerHeight - body.length
      body.push(...details.flatMap(text => wrapText(text, listWidth)).slice(0, Math.max(0, remaining - 1)).map(text => ({ text, style: 'muted' })))
      body.push({ text: tr('Enter 查看详情 / 操作', 'Enter for details / actions'), style: 'accent' })
    }
  }
  const detailLines = details.flatMap(text => wrapText(text, detailWidth || listWidth))
  for (let i = 0; i < innerHeight; i++) {
    const side = sidebar[i], main = body[i]
    out.push(paint(fitText(side?.text ?? '', sidebarWidth), side?.selected ? model.focus === 'sidebar' ? 'selected' : 'accent' : 'muted', color) + paint(' │ ', 'muted', color) +
      paint(fitText(main?.text ?? '', listWidth), main?.style ?? '0', color) +
      (detailWidth ? paint(' │ ', 'muted', color) + paint(fitText(detailLines[i] ?? '', detailWidth), i === 0 ? 'title' : 'muted', color) : ''))
  }
  out.push(paint('─'.repeat(width), 'muted', color), paint(line(`  ${model.notice || tr('就绪 · 配置就绪不代表实时连通', 'Ready · configuration readiness is not live connectivity')}`), model.notice ? 'warn' : 'muted', color),
    paint(line(modal ? tr('  ↑↓ 选择  Tab 下一项  Enter 继续  Esc 取消  Ctrl+C 退出', '  ↑↓ select  Tab next  Enter continue  Esc cancel  Ctrl+C exit') : tr('  Tab 栏切换  ↑↓ 移动  Enter 操作  E 编辑  Space 开关  ? 帮助', '  Tab focus  ↑↓ move  Enter actions  E edit  Space toggle  ? help')), 'accent', color),
    paint(line(tr('  1–8 分类  R 刷新  L 语言  Esc 返回  Q 退出', '  1–8 sections  R reload  L language  Esc back  Q quit')), 'muted', color))
  return out.slice(0, height).join('\n')
}

export const consoleHelp = `Usage: search-boost tui [--dry-run] [--no-color] [--preview]\n\nIndependent full-screen console (the no-argument command keeps the legacy TUI).\n  --dry-run   Preview configuration changes without writing\n  --no-color  Disable colors, retain terminal layout\n  --preview   Print a read-only snapshot without requiring a TTY\n  --help      Show this help\n\nTab: focus · arrows / J K: navigate · 1–8: sections · Enter: actions\nE: edit · Space: toggle · D: delete · R: reload · L: language\n?: help · Esc: cancel/back · Q / Ctrl+C: quit\n`

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
