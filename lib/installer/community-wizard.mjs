import { t, TuiCancelled, TuiExit } from './i18n.mjs'
import { handleCancel, tildify } from './ui.mjs'
import { runXCredentialAction } from './xauth-wizard.mjs'
import { NATIVE_PLATFORMS } from '../community/native-session.mjs'
import { nativeSetupServices, nativeEnablePlan } from '../community/setup-flow.mjs'
import { runNativePlatformSetup, runNativePlatformUninstall, runNativeBrowserSetup, runManagedBrowserUninstall } from './community-setup.mjs'
import { platformConnection, communityErrorText } from '../community/ux.mjs'
import { authStatus, readGrokAuth, readPiAuth, isAuthEntryUsable } from '../search/x/xauth.js'
import { collectRuntimeCapabilities } from '../search/capability.js'
import { toolState, saveToolPreferences } from '../tool-config.mjs'
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
const sourceNote = provider => provider.endsWith('-native') ? t('Built-in free integration; install and log in on this page. No external server. Bilibili video blocks focus public notes and sample comments.', '内置免费接入；在本页安装并登录，无需外部服务。B站视频以公开笔记为主体、评论样本为补充。') : provider === 'existing-x' ? t('No key required for limited fallback; full threads are not guaranteed.', '没有 Key 也可有限检索，不保证完整线程。')
  : provider === 'reddit-arctic' ? t('Searches bounded archived posts, not all Reddit or full comments.', '检索有限范围的归档帖子，不覆盖全站或完整评论。')
    : provider === 'bilibili-public' ? t('Video information only; access may be blocked.', '仅视频信息，可能遇到访问限制。')
      : provider.endsWith('-browser') ? t('Visible search cards only; login and browser setup are manual.', '仅浏览器可见搜索卡片；登录和浏览器接入需手动完成。')
        : t('Indexed search excerpts, not full platform content.', '搜索引擎收录的片段，不是平台完整内容。')

function state(services = nativeSetupServices) {
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
  return { doc, rows, context, runtimeError, setups: Object.fromEntries(NATIVE_PLATFORMS.map(platform => [platform, services.nativeSetupState(platform)])) }
}
function platformRows(s, platform) { return s.rows.filter(row => row.platform === platform) }
function currentRow(s, platform) {
  const rows = platformRows(s, platform)
  return rows.find(row => row.enabled && row.ready) ?? rows.find(row => row.enabled)
}
function status(s, platform) {
  if (NATIVE_PLATFORMS.includes(platform)) { const label = platformConnection(s.rows, platform, s.setups[platform]).label; return t(label[1], label[0]) }
  const row = currentRow(s, platform)
  if (!row) return t('Off', '已停用')
  if (!row.ready) return t('On · setup needed', '已启用 · 待配置')
  if (platform === 'x') return s.context.x.official.available ? t('On · hosted configured', '已启用 · 托管已配置') : t('On · basic search', '已启用 · 基础检索')
  return t(`On · ${sourceName(row.provider)}`, `已启用 · ${sourceName(row.provider)}`)
}
function missingNote(s, row) {
  if (row.ready) return ''
  if (row.provider.endsWith('-native')) return t(`Choose Install free integration / log in below; browser setup is handled here.`, `在下方选择“安装免费接入 / 登录”；浏览器准备在此完成。`)
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
    const message = communityErrorText(error); clack.log.warn(t(message[1], message[0]))
    process.exitCode = 1
  }
}

export async function runCommunityWizard(clack, { dryRun = false, services = nativeSetupServices } = {}) {
  clack.log.info(t('Connect once, then search directly.', '选平台扫码连接，之后直接搜索。'))
  let selected
  for (;;) {
    const s = state(services)
    const browserState = services.nativeSetupState('xiaohongshu')
    const toolOff = !toolState('community_search').enabled
    const options = [...(toolOff ? [{ value: 'enable-tool', label: t('Enable community search tool', '开启社区搜索工具') }] : []), ...ORDER.map(platform => ({ value: platform, label: name(platform), hint: status(s, platform) })),
      { value: 'browser-source', label: t('Browser settings', '浏览器设置'), hint: t('local program or SearchBoost-owned', '本机程序或 SearchBoost 独立浏览器') },
      ...(browserState.managedBrowser?.installed ? [{ value: 'browser-uninstall', label: t('Uninstall SearchBoost-owned browser', '卸载 SearchBoost 独立浏览器') }] : []),
      { value: 'back', label: t('Back', '返回') }]
    let entryNote = ''
    try { if (!toolState('community_search').enabled) entryNote = t('\nCommunity tool is off; enable it in Tool switches.', '\n社区工具已关闭，请在工具开关中开启。') } catch { entryNote = t('\nTool switch configuration could not be read.', '\n无法读取工具开关配置。') }
    const action = await choose(clack, t('Community configuration', 'Community 配置') + entryNote, options, selected)
    if (action === null) return
    selected = action
    if (action === 'enable-tool') {
      if (!dryRun) saveToolPreferences({ community_search: true })
      clack.log.success(dryRun ? t('Preview: tool unchanged.', '预览：工具开关未修改。') : t('Community tool enabled. Reconnect the host if its tool list is stale.', '社区工具已开启；宿主列表未更新时重连即可。'))
      continue
    }
    await operation(clack, () => action === 'browser-source' ? runNativeBrowserSetup(clack, { dryRun, services }) : action === 'browser-uninstall' ? runManagedBrowserUninstall(clack, { dryRun, services }) : platformPage(clack, action, { dryRun, services }))
  }
}

async function platformPage(clack, platform, opts) {
  let selected
  for (;;) {
    const s = state(opts.services), rows = platformRows(s, platform), current = currentRow(s, platform)
    const options = []
    const native = NATIVE_PLATFORMS.includes(platform), setup = native ? opts.services.nativeSetupState(platform) : null
    const preferred = rows.find(row => row.id === `${platform}-default`)
    const connection = native ? platformConnection(rows, platform, setup) : null
    if (native) {
      if (connection.status === 'browser') options.push({ value: 'browser-source', label: t('Repair browser', '修复浏览器') })
      if (connection.configured) options.push({ value: 'view', label: t('Connection details', '连接详情'), hint: t('Ready for search', '已配置，可直接搜索') })
      if (connection.status === 'paused' && setup.session && setup.browser.ready) options.push({ value: 'enable-native', label: t('Resume', '启用'), hint: t('Saved login; no scan needed', '复用登录，无需扫码') })
      options.push({ value: 'install', label: connection.configured || setup.session ? t('Log in again', '重新登录') : t('Scan to connect', '扫码连接') })
    } else if (!preferred?.enabled) options.push({ value: 'enable', label: t('Enable', '启用') })
    if (current?.provider === 'reddit-arctic') options.push({ value: 'scopes', label: t('Default subreddits', '默认检索社区'), hint: current.config.subreddits?.map(scope => `r/${scope}`).join(', ') || t('Auto-discover', '自动发现') })
    if (platform === 'x') {
      if (readGrokAuth()) options.push({ value: 'import-grok', label: t('Import existing Grok login', '导入已有 Grok 登录') })
      options.push({ value: 'set-key', label: t('Set / replace xAI API Key', '设置 / 更换 xAI API Key') })
      if (readPiAuth()?.key) options.push({ value: 'remove-key', label: t('Remove local credential copy', '移除本地凭据副本'), hint: t('Does not disable X or remove environment keys', '不关闭 X，不删除环境变量 Key') })
    }
    if (native ? connection.enabled : rows.some(row => row.enabled)) options.push({ value: 'disable', label: t('Disable this platform', '停用此平台') })
    // Existing custom instances are managed where they belong, not in a second global menu.
    const extras = rows.filter(row => !isBuiltInCommunityBackend(row.id) && !row.provider.endsWith('-native'))
    if (extras.length) options.push({ value: 'remove-instance', label: extras.length === 1 ? t(`Delete ${sourceName(extras[0].provider)} settings`, `删除${sourceName(extras[0].provider)}配置`) : t('Delete extra configuration', '删除额外配置'), hint: t('Built-in configurations are retained', '保留内置配置') })
    if (!connection?.configured) options.push({ value: 'view', label: t('Details', '详情'), hint: t('read-only', '只读') })
    if (native && (setup.installed || rows.some(row => row.provider === `${platform}-native`))) options.push({ value: 'uninstall', label: t('Disconnect and delete login', '断开并删除登录'), hint: t('Browser is kept', '保留浏览器') })
    options.push({ value: 'back', label: t('Back', '返回') })
    const detail = native ? t(connection.configured ? 'Ready for search; login is reused.' : setup.session ? 'Saved login available.' : 'Scan with the platform app to connect.', connection.configured ? '已配置，后续复用登录。' : setup.session ? '已有保存的登录。' : '用平台 App 扫码即可连接。') : current ? [sourceNote(current.provider), missingNote(s, current)].filter(Boolean).join('\n') : platform === 'x' ? t('Enable X to use basic search.', '启用 X 后可进行基础检索。') : t('Enable the free integration below.', '在下方启用免费接入。')
    const credential = platform === 'x' ? '\n' + xCredentialNote() : ''
    const action = await choose(clack, `${name(platform)} — ${status(s, platform)}\n${detail}${credential}`, options, selected)
    if (action === null) return
    selected = action
    await operation(clack, async () => {
      if (action === 'view') clack.note([...rows.map(row => `${row.id} · ${previewRow(row)}\n${sourceNote(row.provider)}${row.enabled && !row.ready ? '\n' + missingNote(s, row) : ''}`), ...(platform === 'x' ? [xCredentialNote()] : []), t('Configuration only; not live connectivity or coverage.', '仅配置状态，不代表实时连通或覆盖率。')].join('\n'), name(platform))
      else if (action === 'install') { const result = await runNativePlatformSetup(clack, platform, opts); if (result?.installed) selected = 'back' }
      else if (action === 'browser-source') await runNativeBrowserSetup(clack, opts)
      else if (action === 'uninstall') await runNativePlatformUninstall(clack, platform, opts)
      else if (action === 'enable-native') await commit(clack, nativeEnablePlan(platform), opts)
      else if (action === 'enable') await commit(clack, platformPlan(s.doc, platform, { action: 'select', backend: instance(preferred) }), opts)
      else if (action === 'scopes') await configureRow(clack, platform, current, opts, 'configure', s.doc)
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
  } else throw new Error('Only the built-in Reddit integration has editable scopes')
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
  if (plan.change.action === 'remove' || opts.dryRun) clack.note(changes.join('\n'), t(`${name(plan.platform)} — changes`, `${name(plan.platform)} — 变更`))
  if (plan.change.action !== 'remove') {
    applyCommunityPlatformPlan(plan, opts)
    clack.log.success(opts.dryRun ? t('Preview only; nothing saved.', '预览完成，未保存。') : t('Saved.', '已保存。'))
    return
  }
  const consent = await clack.confirm({ message: opts.dryRun ? t('Preview only; nothing will be saved. Continue?', '仅预览，不保存。继续？') : t('Save these changes?', '保存这些变更？'), initialValue: false })
  handleCancel(consent, clack)
  if (consent !== true) return
  try { applyCommunityPlatformPlan(plan, opts) } catch (error) {
    if (error.message === 'Community configuration changed; review the change again') throw new Error(t('Configuration changed. Please choose again.', '配置已更改，请重新选择。'))
    throw error
  }
  clack.log.success(opts.dryRun ? t('Preview complete; nothing saved.', '预览完成，未保存。') : t('Saved.', '已保存。'))
}
