import { emitKeypressEvents } from 'node:readline'
import { t, TuiCancelled, TuiExit } from './i18n.mjs'
import { handleCancel } from './ui.mjs'
import { NATIVE_PLATFORMS } from '../community/native-session.mjs'
import { nativeSetupServices, installNativePlatform, uninstallNativePlatform } from '../community/setup-flow.mjs'
import { qrFileHyperlink, openQrPng } from '../community/qr-terminal.mjs'
import { browserChoices, reusableBrowserChoice, platformConnection, communityErrorText } from '../community/ux.mjs'
import { planCommunityPlatformChange, readCommunityConfig } from '../community/config.mjs'
import { toolState } from '../tool-config.mjs'

const text = (zh, en) => t(en, zh)

export const nativePlatformName = platform => ({ bilibili: text('B站', 'Bilibili'), zhihu: text('知乎', 'Zhihu'), xiaohongshu: text('小红书', 'Xiaohongshu') })[platform]
export const nativeSetupNote = () => text('扫码一次，后续复用登录；个人浏览器数据始终隔离。', 'Scan once; saved logins are reused. Personal browser data stays separate.')
const tick = () => new Promise(resolve => setImmediate(resolve))
const phaseText = (phase, percent) => ({
  discover: text('准备浏览器…', 'Preparing browser…'), install: text('下载独立浏览器…', 'Downloading browser…'),
  download: text('下载独立浏览器…', 'Downloading browser…') + (Number.isInteger(percent) ? ` ${percent}%` : ''),
  verify: text('检查下载…', 'Checking download…'), ready: text('浏览器已就绪', 'Browser ready'),
  preparing: text('获取登录二维码…', 'Getting login QR…'), opening: text('打开登录页…', 'Opening login page…'),
  authenticated: text('保存登录…', 'Saving login…'),
})[phase] ?? text('准备连接…', 'Preparing connection…')

/** Only ask when no usable program exists, or the user explicitly opens settings.
 * Choosing the labelled download action is the download consent, not another yes/no.
 */
export async function selectNativeBrowserChoice(clack, services = nativeSetupServices, { force = false } = {}) {
  let state = services.nativeSetupState('xiaohongshu')
  const reuse = reusableBrowserChoice(state)
  if (!force && reuse) return reuse
  const spinner = clack.spinner?.(); spinner?.start(text('查找浏览器…', 'Finding browsers…'))
  try { await tick(); state = services.nativeSetupState('xiaohongshu', { discover: true }) }
  finally { spinner?.stop(text('浏览器检查完成', 'Browser check complete')) }
  if (!force && reusableBrowserChoice(state)) return reusableBrowserChoice(state)
  const choices = browserChoices(state)
  const result = await clack.select({ message: text('选择浏览器（个人数据隔离）', 'Choose browser (personal data stays separate)'), options: [
    ...choices.map(option => ({ value: option.value, label: option.value === 'managed'
      ? state.managedBrowser?.ready ? text('使用独立 Chromium', 'Use owned Chromium') : text('下载独立 Chromium 并继续（需联网）', 'Download owned Chromium and continue (network)')
      : option.label, hint: option.choice.path ?? text('SearchBoost 专用，可卸载', 'SearchBoost-owned, removable') })),
    { value: 'back', label: text('返回', 'Back') },
  ], initialValue: state.preference?.source === 'managed' ? 'managed' : choices.find(option => option.choice.path === state.preference?.path)?.value ?? choices[0]?.value })
  if (clack.isCancel(result) || result === 'back') return null
  const selected = choices.find(option => option.value === result)
  if (!selected) throw new Error('Unknown browser source')
  return selected.choice
}

function inputController(input = process.stdin, { open = openQrPng, onOpenFailure } = {}) {
  const controller = new AbortController(), state = { interrupted: false, cancelled: false, restart: false, path: null, closed: false }
  const raw = input.isRaw, paused = input.isPaused?.() || input.readableFlowing !== true, ownsRaw = Boolean(input.isTTY && input.setRawMode)
  const interrupt = () => { state.interrupted = true; controller.abort() }
  let opening = false
  const onKey = async (_text, key) => {
    if (key?.ctrl && key.name === 'c' || key?.name === 'q') { interrupt(); return }
    if (key?.name === 'escape') { state.cancelled = true; controller.abort(); return }
    if (key?.name === 'r' && state.path) { state.restart = true; controller.abort(); return }
    if (key?.name === 'o' && state.path && !opening) {
      opening = true
      try { await open(state.path) } catch { if (!state.closed) { try { onOpenFailure?.() } catch { /* advisory */ } } }
      finally { opening = false }
    }
  }
  process.once('SIGINT', interrupt); input.on('keypress', onKey)
  if (ownsRaw) { emitKeypressEvents(input); input.setRawMode(true); input.resume() }
  return { controller, state, close() {
    state.closed = true
    process.off('SIGINT', interrupt); input.off('keypress', onKey)
    if (ownsRaw) { input.setRawMode(Boolean(raw)); if (paused) input.pause() }
  } }
}

export async function runNativeBrowserSetup(clack, { dryRun = false, services = nativeSetupServices } = {}) {
  const choice = await selectNativeBrowserChoice(clack, services, { force: true })
  if (!choice) return
  if (dryRun) { clack.log.info(text('预览：不下载、不保存。', 'Preview: no download or writes.')); return }
  const input = inputController(), spinner = clack.spinner?.()
  spinner?.start(text('准备浏览器…', 'Preparing browser…'))
  try {
    await services.ensureNativeBrowser({ source: choice.source, executable: choice.path, signal: input.controller.signal, onProgress: event => spinner?.message?.(phaseText(event?.phase, event?.percent)) })
    input.controller.signal.throwIfAborted(); services.selectNativeBrowser(choice)
    spinner?.stop(text('浏览器已就绪', 'Browser ready'))
  } catch (error) {
    spinner?.stop(text('未完成', 'Not completed'))
    if (input.state.interrupted) throw new TuiExit()
    if (!input.state.cancelled) clack.log.warn(text(...communityErrorText(error)))
  } finally { input.close() }
}

export async function runManagedBrowserUninstall(clack, { dryRun = false, services = nativeSetupServices } = {}) {
  const consent = await clack.confirm({ message: text('卸载独立浏览器？保留本机浏览器和登录数据。', 'Remove owned browser? Local browsers and saved logins are kept.'), initialValue: false })
  handleCancel(consent, clack)
  if (consent !== true) return
  if (!dryRun) services.removeManagedBrowser()
  clack.log.success(dryRun ? text('预览：未卸载。', 'Preview: not removed.') : text('独立浏览器已卸载。', 'Owned browser removed.'))
}

export async function runNativePlatformSetup(clack, platform, { dryRun = false, services = nativeSetupServices, browserChoice: selectedBrowser, input: suppliedInput } = {}) {
  if (dryRun) { clack.log.info(text('预览：连接账号，不下载或生成二维码。', 'Preview: connect account; no download or QR.')); return { preview: true } }
  let browserChoice = selectedBrowser ?? await selectNativeBrowserChoice(clack, services)
  if (!browserChoice) return { cancelled: true }
  for (;;) {
    const spinner = clack.spinner?.()
    const input = inputController(suppliedInput, { open: services.openQrPng ?? openQrPng, onOpenFailure: () => {
      spinner?.stop(text('无法打开图片', 'Could not open image'))
      clack.log.warn(text('请使用上方 PNG 路径打开图片。', 'Open the PNG using its path above.'))
      spinner?.start(text('等待扫码确认…', 'Waiting for scan…'))
    } })
    let error, result
    spinner?.start(text(`${nativePlatformName(platform)}：准备连接…`, `${nativePlatformName(platform)}: preparing…`))
    try {
      result = await installNativePlatform(platform, null, { services, browserChoice, loginMode: 'qr', signal: input.controller.signal,
        onProgress: event => spinner?.message?.(phaseText(event?.phase, event?.percent)),
        onQr: qr => {
          input.state.path = qr.path
          spinner?.stop(text('二维码已就绪', 'QR ready'))
          clack.note(`${qrFileHyperlink(qr.path)}\n${text(`用${nativePlatformName(platform)} App 扫码 · O 打开 · R 重发 · Esc 返回`, `Scan with ${nativePlatformName(platform)} app · O open · R refresh · Esc back`)}`, nativePlatformName(platform))
          spinner?.start(text('等待扫码确认…', 'Waiting for scan…'))
        },
        onStatus: status => spinner?.message?.(status.phase === 'waiting'
          ? text(`等待扫码 · ${status.remainingSeconds} 秒`, `Waiting for scan · ${status.remainingSeconds}s`)
          : phaseText(status.phase)),
      })
    } catch (failure) { error = failure }
    finally { spinner?.stop(error ? text('连接未完成', 'Not connected') : text('完成', 'Done')); input.close() }
    if (input.state.interrupted) throw new TuiExit()
    if (input.state.restart) continue
    if (input.state.cancelled) { clack.log.info(text('已取消，已有登录保留。', 'Cancelled; saved logins kept.')); return { cancelled: true } }
    if (!error) {
      clack.log.success(text(`${nativePlatformName(platform)}已连接，可直接搜索。`, `${nativePlatformName(platform)} connected. Search directly.`))
      try { if (!toolState('community_search').enabled) clack.log.warn(text('社区工具已关闭，请在工具开关中开启。', 'Community tool is off; enable it in Tool switches.')) } catch { /* Separate tool settings are not overwritten. */ }
      return result
    }
    clack.log.warn(text(...communityErrorText(error)))
    const retry = await clack.select({ message: text('连接未完成', 'Connection incomplete'), options: [
      { value: 'retry', label: text('重试连接', 'Retry connection') },
      ...(['browser_unavailable', 'browser_install_failed', 'browser_preference_invalid', 'managed_browser_unsafe'].includes(error.kind) ? [{ value: 'browser', label: text('浏览器设置', 'Browser settings') }] : []),
      { value: 'back', label: text('稍后再说', 'Later') },
    ] })
    if (retry === 'browser') { browserChoice = await selectNativeBrowserChoice(clack, services, { force: true }); if (browserChoice) continue }
    if (clack.isCancel(retry) || retry !== 'retry') return { failed: true }
  }
}

export async function runNativePlatformUninstall(clack, platform, { dryRun = false, services = nativeSetupServices } = {}) {
  const plan = planCommunityPlatformChange(platform, { action: 'uninstall-native' })
  const consent = await clack.confirm({ message: text(`断开${nativePlatformName(platform)}并删除登录数据？`, `Disconnect ${nativePlatformName(platform)} and delete its login data?`), initialValue: false })
  handleCancel(consent, clack)
  if (consent !== true) return
  uninstallNativePlatform(plan, { services, dryRun })
  clack.log.success(dryRun ? text('预览：未删除。', 'Preview: not removed.') : text('已断开，浏览器保留。', 'Disconnected; browser kept.'))
}

export async function runCommunityStep(clack, opts = {}, { services = nativeSetupServices } = {}) {
  if (opts.yes || opts.uninstall || opts.skipKeys || opts.skipCommunity) return { ok: true, skipped: true }
  if (opts.dryRun) { clack.log.info(text('预览：最后可连接社区账号，不下载或写入。', 'Preview: optional community accounts last; no download or writes.')); return { ok: true, skipped: true } }
  const doc = readCommunityConfig()
  const configured = platform => platformConnection(doc.backends, platform, services.nativeSetupState(platform)).configured
  const platforms = await clack.multiselect({ message: text('连接社区账号（可跳过，空选继续）', 'Connect community accounts (optional; select none to skip)'),
    options: NATIVE_PLATFORMS.map(platform => ({ value: platform, label: nativePlatformName(platform), hint: configured(platform) ? text('已配置，无需重复连接', 'Configured; no login needed') : text('扫码后直接使用', 'Scan once, then search') })), initialValues: [], required: false })
  handleCancel(platforms, clack)
  if (!Array.isArray(platforms) || platforms.some(platform => !NATIVE_PLATFORMS.includes(platform))) throw new Error('Unknown community platform')
  if (!platforms.length) return { ok: true, skipped: true }
  const pending = [...new Set(platforms)].filter(platform => !configured(platform)), skipped = platforms.length - pending.length
  if (!pending.length) { clack.log.success(text('所选平台均已配置，可直接搜索。', 'Selected platforms are configured. Search directly.')); return { ok: true, skipped: true } }
  const browserChoice = await selectNativeBrowserChoice(clack, services)
  if (!browserChoice) return { ok: true, skipped: true }
  const failed = [], connected = []
  for (const platform of pending) {
    try {
      const result = await runNativePlatformSetup(clack, platform, { services, browserChoice })
      if (result?.installed) connected.push(platform)
      else failed.push(platform)
    } catch (error) { if (error instanceof TuiExit) throw error; if (!(error instanceof TuiCancelled)) clack.log.warn(text(...communityErrorText(error))); failed.push(platform) }
  }
  clack.log.info(text(`社区连接：${connected.length} 已连接 · ${skipped} 已配置 · ${failed.length} 未完成。`, `Community: ${connected.length} connected · ${skipped} already configured · ${failed.length} incomplete.`))
  if (failed.length) process.exitCode = 1
  return { ok: !failed.length, failed, connected, skipped }
}
