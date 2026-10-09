import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t, TuiCancelled, TuiExit } from './i18n.mjs'
import { handleCancel, tildify } from './ui.mjs'
import { runXCredentialAction } from './xauth-wizard.mjs'
import { authStatus, readGrokAuth, readPiAuth, isAuthEntryUsable } from '../search/x/xauth.js'
import { collectRuntimeCapabilities } from '../search/capability.js'
import { toolState } from '../tool-config.mjs'
import {
  communityRegistry, readCommunityConfig, communityConfigPath, isBuiltInCommunityBackend,
  planCommunityPlatformChange, applyCommunityPlatformPlan,
} from '../community/config.mjs'

const ORDER = ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu']
const name = platform => ({ reddit: 'Reddit', x: 'X', bilibili: t('Bilibili', 'B站'), zhihu: t('Zhihu', '知乎'), xiaohongshu: t('Xiaohongshu', '小红书') })[platform]
const sourceName = provider => provider.endsWith('-native') ? t('Station content', '站内正文') : provider === 'existing-x' ? t('Hosted / fallback', '托管 / 回退')
  : provider === 'reddit-arctic' ? t('Archive search', '归档检索')
    : provider === 'bilibili-public' ? t('Public video API', '公共视频接口')
      : provider.endsWith('-browser') ? t('Browser search cards', '浏览器搜索卡片') : t('Web index', '网页索引')
const sourceNote = provider => provider.endsWith('-native') ? t('Integrated search/details; initialize an owned session with community-login. No external server. Bilibili video blocks focus public notes and sample comments.', '项目内部搜索/详情；用 community-login 初始化专用会话，不需要外部服务。B站视频以公开笔记为主体、评论样本为补充。') : provider === 'existing-x' ? t('No key required for limited fallback; full threads are not guaranteed.', '没有 Key 也可有限检索，不保证完整线程。')
  : provider === 'reddit-arctic' ? t('Searches bounded archived posts, not all Reddit or full comments.', '检索有限范围的归档帖子，不覆盖全站或完整评论。')
    : provider === 'bilibili-public' ? t('Video information only; access may be blocked.', '仅视频信息，可能遇到访问限制。')
      : provider.endsWith('-browser') ? t('Visible search cards only; login and browser setup are manual.', '仅浏览器可见搜索卡片；登录和浏览器接入需手动完成。')
        : t('Indexed search excerpts, not full platform content.', '搜索引擎收录的片段，不是平台完整内容。')

function state() {
  let doc
  try { doc = readCommunityConfig() } catch {
    throw new Error(t(`Community configuration cannot be read. Repair ${tildify(communityConfigPath())}; nothing was reset.`, `无法读取社区配置，请修复 ${tildify(communityConfigPath())}；未重置文件。`))
  }
  let context, runtimeError = false
  try { context = collectRuntimeCapabilities() } catch {
    runtimeError = true
    context = { availableEngines: [], x: { official: { available: false }, fallback: { available: false } } }
  }
  const rows = doc.backends.map(row => {
    const provider = communityRegistry.get(row.provider)
    return { ...row, platform: provider.platform, ready: provider.describeAvailability(context, row.config).ready }
  })
  return { doc, rows, context, runtimeError }
}
function platformRows(s, platform) { return s.rows.filter(row => row.platform === platform) }
function currentRow(s, platform) {
  const rows = platformRows(s, platform)
  return rows.find(row => row.enabled && row.ready) ?? rows.find(row => row.enabled)
}
function status(s, platform) {
  const row = currentRow(s, platform)
  if (!row) return t('Off', '已停用')
  if (!row.ready) return t('On · setup needed', '已启用 · 待配置')
  if (platform === 'x') return s.context.x.official.available ? t('On · hosted configured', '已启用 · 托管已配置') : t('On · basic search', '已启用 · 基础检索')
  return t(`On · ${sourceName(row.provider)}`, `已启用 · ${sourceName(row.provider)}`)
}
function missingNote(s, row) {
  if (row.ready) return ''
  if (row.provider.endsWith('-native')) return t(`Run search-boost community-login ${row.platform}. Chromium must be available; user performs login.`, `运行 search-boost community-login ${row.platform}；需要 Chromium，由本人登录。`)
  if (row.provider.endsWith('-browser')) return t(`Missing environment variable: ${row.config.token_env}.`, `缺少环境变量：${row.config.token_env}。`)
  return s.runtimeError ? t('Search configuration could not be read.', '无法读取搜索配置。') : t('Configure an available search engine first.', '请先配置可用的搜索引擎。')
}

/** Short, read-only overview also used by the existing Status screen. */
export function formatCommunityStatusLines() {
  try {
    const s = state()
    return [t('Community', '社区检索'), ...ORDER.map(platform => `  ${name(platform)}: ${status(s, platform)}`), t('  Setup status only; connections have not been tested.', '  仅配置状态，未测试实际连接。')]
  } catch { return [t('Community: configuration error', '社区检索：配置错误')] }
}

async function choose(clack, message, options, initialValue) {
  const result = await clack.select({ message, options, ...(options.some(row => row.value === initialValue) ? { initialValue } : {}) })
  if (clack.isCancel(result) || result === 'back') return null
  if (!options.some(row => row.value === result)) throw new Error('Unknown community menu action')
  return result
}

/** Esc returns to the containing page, while Ctrl+C is allowed to reach the TUI shell. */
async function operation(clack, work) {
  try { await work() } catch (error) {
    if (error instanceof TuiExit) throw error
    if (error instanceof TuiCancelled) return
    clack.log.error(error.message ?? String(error))
    process.exitCode = 1
  }
}

export async function runCommunityWizard(clack, { dryRun = false } = {}) {
  clack.log.info(t('Choose a platform, then enable / change its source. Platform switches do not opt each search into community; that is controlled by the community parameter. Configuration status only; no connection tests.', '选择平台后直接启用或更换检索方式。平台开关不等于每次搜索自动加入社区，是否加入仍由 community 参数决定。仅配置状态，未测试连接。'))
  let selected
  for (;;) {
    const s = state()
    const options = [...ORDER.map(platform => ({ value: platform, label: name(platform), hint: status(s, platform) })), { value: 'back', label: t('Back', '返回') }]
    let entryNote = ''
    try { if (!toolState('community_search').enabled) entryNote = t('\nStandalone tool is off; change it in Tool switches. Fused/Adaptive platform settings still apply.', '\n独立社区工具已关闭，可在“工具开关”中开启；综合搜索仍可使用平台设置。') } catch { entryNote = t('\nTool switch configuration could not be read.', '\n无法读取工具开关配置。') }
    const action = await choose(clack, t('Community configuration', 'Community 配置') + entryNote, options, selected)
    if (action === null) return
    selected = action
    await operation(clack, () => platformPage(clack, action, { dryRun }))
  }
}

async function platformPage(clack, platform, opts) {
  let selected
  for (;;) {
    const s = state(), rows = platformRows(s, platform), current = currentRow(s, platform)
    const options = []
    if (platform === 'x' && !current && rows.length === 1) options.push({ value: 'enable', label: t('Enable X', '启用 X') })
    else if (platform !== 'x' || rows.length > 1) options.push({ value: 'source', label: current ? t('Change search source', '更换检索方式') : t('Enable / choose source', '启用并选择检索方式') })
    if (current?.provider === 'reddit-arctic') options.push({ value: 'scopes', label: t('Default subreddits', '默认检索社区'), hint: current.config.subreddits?.map(scope => `r/${scope}`).join(', ') || t('Auto-discover', '自动发现') })
    if (current?.provider.endsWith('-browser')) options.push({ value: 'browser', label: t('Browser connection settings', '浏览器接入设置') })
    const editableSaved = rows.filter(row => row.id !== current?.id && (row.provider === 'reddit-arctic' || row.provider.endsWith('-browser')))
    for (const row of editableSaved) options.push({ value: `configure:${row.id}`, label: t(`Edit saved ${sourceName(row.provider)} settings`, `编辑已保存的${sourceName(row.provider)}参数`), hint: t('does not switch the current source', '不切换当前检索方式') + (editableSaved.filter(other => other.provider === row.provider).length > 1 ? ` · ${row.id}` : '') })
    if (platform === 'x') {
      if (readGrokAuth()) options.push({ value: 'import-grok', label: t('Import existing Grok login', '导入已有 Grok 登录') })
      options.push({ value: 'set-key', label: t('Set / replace xAI API Key', '设置 / 更换 xAI API Key') })
      if (readPiAuth()?.key) options.push({ value: 'remove-key', label: t('Remove local credential copy', '移除本地凭据副本'), hint: t('Does not disable X or remove environment keys', '不关闭 X，不删除环境变量 Key') })
    }
    if (rows.some(row => row.enabled)) options.push({ value: 'disable', label: t('Disable this platform', '停用此平台') })
    // Existing custom instances are managed where they belong, not in a second global menu.
    const extras = rows.filter(row => !isBuiltInCommunityBackend(row.id))
    if (extras.length) options.push({ value: 'remove-instance', label: extras.length === 1 ? t(`Delete ${sourceName(extras[0].provider)} settings`, `删除${sourceName(extras[0].provider)}配置`) : t('Delete extra configuration', '删除额外配置'), hint: t('Built-in configurations are retained', '保留内置配置') })
    options.push({ value: 'view', label: t('View saved configuration', '查看已保存配置'), hint: t('read-only · sources and parameters', '只读 · 检索方式与参数') })
    options.push({ value: 'back', label: t('Back', '返回') })
    const detail = current ? [sourceNote(current.provider), missingNote(s, current)].filter(Boolean).join('\n') : platform === 'x' ? t('Enable X to use basic search.', '启用 X 后可进行基础检索。') : t('Choose a search source to enable this platform.', '选择检索方式后启用此平台。')
    const credential = platform === 'x' ? '\n' + xCredentialNote() : ''
    const action = await choose(clack, `${name(platform)} — ${status(s, platform)}\n${detail}${credential}`, options, selected)
    if (action === null) return
    selected = action
    await operation(clack, async () => {
      if (action === 'view') clack.note([...rows.map(row => `${row.id} · ${previewRow(row)}\n${sourceNote(row.provider)}${row.enabled && !row.ready ? '\n' + missingNote(s, row) : ''}`), ...(platform === 'x' ? [xCredentialNote()] : []), t('Configuration only; not live connectivity or coverage.', '仅配置状态，不代表实时连通或覆盖率。')].join('\n'), name(platform))
      else if (action === 'source') await chooseSource(clack, s, platform, opts)
      else if (action === 'enable') await commit(clack, platformPlan(s.doc, platform, { action: 'select', backend: instance(rows[0]) }), opts)
      else if (action === 'scopes') await configureRow(clack, platform, current, opts, 'configure', s.doc)
      else if (action === 'browser') await configureRow(clack, platform, current, opts, 'configure', s.doc)
      else if (action.startsWith('configure:')) {
        const row = editableSaved.find(row => action === `configure:${row.id}`)
        if (!row) throw new Error('Unknown saved source')
        await configureRow(clack, platform, row, opts, 'configure', s.doc)
      }
      else if (action === 'disable') await commit(clack, platformPlan(s.doc, platform, { action: 'disable' }), opts)
      else if (action === 'remove-instance') {
        const id = extras.length === 1 ? extras[0].id : await choose(clack, t('Delete which extra configuration?', '删除哪份额外配置？'), [...extras.map(row => ({ value: row.id, label: `${sourceName(row.provider)} · ${row.id}`, hint: row.enabled ? t('On', '已启用') : t('Off', '已停用') })), { value: 'back', label: t('Back', '返回') }])
        if (id) await commit(clack, platformPlan(s.doc, platform, { action: 'remove', id }), opts)
      } else if (action === 'remove-key') {
        const confirm = await clack.confirm({ message: t('Remove the local X credential copy? Environment keys stay unchanged.', '移除本地 X 凭据副本？环境变量 Key 保持不变。'), initialValue: false })
        handleCancel(confirm, clack)
        if (confirm === true) await runXCredentialAction(clack, 'remove', opts)
      } else await runXCredentialAction(clack, action, opts)
    })
  }
}
function xCredentialNote() {
  const status = authStatus()
  if (status.source === 'env') return t('Credential: XAI_API_KEY environment variable (takes priority).', '凭据：XAI_API_KEY 环境变量（优先使用）。')
  if (status.source === 'local') return isAuthEntryUsable(readPiAuth()) ? t('Credential: local copy.', '凭据：本地副本。') : t('Local credential is unavailable; replace or re-import it.', '本地凭据不可用，请更换 Key 或重新导入登录。')
  if (status.source === 'grok-pending') return t('Existing Grok login can be imported.', '已找到 Grok 登录，可导入。')
  return t('Hosted credentials are optional.', '托管凭据为可选项。')
}

function newRow(s, provider) {
  const base = `tui-${provider.id}`
  let id = base, count = 2
  while (s.rows.some(row => row.id === id)) id = `${base}-${count++}`
  return { id, provider: provider.id, enabled: false, config: {} }
}
async function chooseSource(clack, s, platform, opts) {
  const rows = platformRows(s, platform), providers = communityRegistry.list().filter(provider => provider.platform === platform)
  const choices = []
  for (const provider of providers) {
    const existing = rows.filter(row => row.provider === provider.id)
    if (existing.length) for (const row of existing) choices.push({ row, value: row.id, label: sourceName(provider.id) + (existing.length > 1 ? ` · ${row.id}` : ''), hint: sourceNote(provider.id) })
    else choices.push({ row: newRow(s, provider), value: `new:${provider.id}`, label: sourceName(provider.id), hint: sourceNote(provider.id) })
  }
  const id = await choose(clack, t('Choose search source', '选择检索方式'), [...choices.map(({ row: _row, ...option }) => option), { value: 'back', label: t('Back', '返回') }], currentRow(s, platform)?.id)
  if (!id) return
  const row = choices.find(choice => choice.value === id).row
  if (row.provider.endsWith('-browser') && (!row.config.endpoint || !communityRegistry.get(row.provider).describeAvailability({}, row.config).ready)) await configureRow(clack, platform, row, opts, 'select', s.doc)
  else await commit(clack, platformPlan(s.doc, platform, { action: 'select', backend: instance(row) }), opts)
}

async function configureRow(clack, platform, row, opts, action, before) {
  let config
  if (row.provider === 'reddit-arctic') {
    const value = await clack.text({
      message: t('Default subreddits (up to 5; comma-separated; empty = auto-discover)', '默认检索社区（最多 5 个，逗号分隔；留空则自动发现）'),
      placeholder: 'LocalLLaMA, node', initialValue: row.config.subreddits?.join(', ') ?? '',
      validate: value => { try { parseScopes(value) } catch { return t('Enter up to 5 valid subreddit names.', '请输入最多 5 个有效社区名称。') } },
    })
    handleCancel(value, clack)
    config = parseScopes(value)
  } else {
    const extension = tildify(resolve(fileURLToPath(new URL('../../browser/community-bridge/', import.meta.url))))
    clack.note(t(`1. Run search-boost community-browser yourself.\n2. Load the Chrome extension: ${extension}\n3. Set the token in the extension and explicitly Enable.\n4. Set its environment variable in the SearchBoost process.\nDo not paste the token here. Existing hosts may need restarting.`, `1. 手动运行 search-boost community-browser。\n2. Chrome 手动加载扩展：${extension}\n3. 扩展中填入令牌并明确启用。\n4. 给 SearchBoost 进程设置令牌环境变量。\n不要在这里输入令牌；已有宿主可能需要重启。`), t('Browser setup', '浏览器接入'))
    const endpoint = await clack.text({ message: t('Local bridge address', '本地桥地址'), initialValue: row.config.endpoint ?? 'http://127.0.0.1:19826', validate: value => {
      try { communityRegistry.get(row.provider).validateConfig({ endpoint: value, token_env: 'SEARCH_BOOST_BROWSER_TOKEN' }) } catch { return t('Use a loopback HTTP origin, e.g. http://127.0.0.1:19826.', '请输入本地 HTTP 地址，如 http://127.0.0.1:19826；不带路径或凭据。') }
    } })
    handleCancel(endpoint, clack)
    const token_env = await clack.text({ message: t('Token environment variable NAME (not its value)', '令牌环境变量名（不是令牌内容）'), initialValue: row.config.token_env ?? 'SEARCH_BOOST_BROWSER_TOKEN', validate: value => /^[A-Z][A-Z0-9_]{0,127}$/.test(String(value)) ? undefined : t('Enter an uppercase environment variable name.', '请输入大写环境变量名，不要输入令牌。') })
    handleCancel(token_env, clack)
    config = communityRegistry.get(row.provider).validateConfig({ endpoint, token_env })
    if (!communityRegistry.get(row.provider).describeAvailability({}, config).ready) {
      if (action === 'select') {
        action = 'configure'
        clack.log.warn(t(`Missing ${token_env}. Save settings only; search source stays unchanged.`, `缺少 ${token_env}。仅保存配置，不更换检索方式。`))
      } else clack.log.warn(t(`Missing ${token_env}; browser search is not ready.`, `缺少 ${token_env}，浏览器检索尚未就绪。`))
    }
  }
  await commit(clack, platformPlan(before, platform, { action, backend: { ...instance(row), config } }), opts)
}
function instance(row) {
  return { id: row.id, provider: row.provider, enabled: row.enabled, config: row.config }
}
function platformPlan(before, platform, change) {
  const plan = planCommunityPlatformChange(platform, change)
  if (JSON.stringify(plan.before) !== JSON.stringify(before)) throw new Error(t('Configuration changed. Please choose again.', '配置已更改，请重新选择。'))
  return plan
}
function parseScopes(value) {
  const scopes = String(value ?? '').trim().split(/[,，\s]+/).filter(Boolean).map(scope => scope.replace(/^r\//i, ''))
  return communityRegistry.get('reddit-arctic').validateConfig(scopes.length ? { subreddits: scopes } : {})
}
function previewRow(row) {
  const details = row.config.subreddits?.length ? row.config.subreddits.map(scope => `r/${scope}`).join(', ')
    : row.config.endpoint ? `${row.config.endpoint} · ${row.config.token_env}` : ''
  return `${sourceName(row.provider)} · ${row.enabled ? t('On', '启用') : t('Off', '停用')}${details ? ` · ${details}` : ''}`
}
async function commit(clack, plan, opts) {
  if (!plan.changed) { clack.log.info(t('No changes.', '未改变配置。')); return }
  const before = new Map(plan.before.backends.map(row => [row.id, row]))
  const changes = plan.after.backends.filter(row => JSON.stringify(before.get(row.id)) !== JSON.stringify(row)).map(row => `${previewRow(row)}${isBuiltInCommunityBackend(row.id) ? '' : ` (${row.id})`}`)
  for (const row of plan.before.backends.filter(row => !plan.after.backends.some(next => next.id === row.id))) changes.push(t(`Delete ${sourceName(row.provider)} (${row.id})`, `删除 ${sourceName(row.provider)}（${row.id}）`))
  clack.note(changes.join('\n'), t(`${name(plan.platform)} — changes`, `${name(plan.platform)} — 变更`))
  const consent = await clack.confirm({ message: opts.dryRun ? t('Preview only; nothing will be saved. Continue?', '仅预览，不保存。继续？') : t('Save these changes?', '保存这些变更？'), initialValue: false })
  handleCancel(consent, clack)
  if (consent !== true) return
  try { applyCommunityPlatformPlan(plan, opts) } catch (error) {
    if (error.message === 'Community configuration changed; review the change again') throw new Error(t('Configuration changed. Please choose again.', '配置已更改，请重新选择。'))
    throw error
  }
  clack.log.success(opts.dryRun ? t('Preview complete; nothing saved.', '预览完成，未保存。') : t('Saved.', '已保存。'))
}
