import { emitKeypressEvents } from 'node:readline'
import { dshDesktopStatus } from '../dsh-desktop.mjs'
import { dshDesktopLocalSource, waitForDshDesktopLocal } from '../dsh-desktop-local.mjs'
import { t } from './i18n.mjs'

/** Own only the wait screen's input handlers; restore terminal state on every exit. */
export function desktopWaitCancellation(input = process.stdin, events = process) {
  const controller = new AbortController()
  const raw = input.isRaw === true
  const paused = input.isPaused?.() ?? false
  const abort = () => controller.abort()
  const onKey = (_text, key) => {
    if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) abort()
  }
  const closed = input.readableEnded || input.destroyed
  if (input.isTTY && !closed) {
    emitKeypressEvents(input)
    input.setRawMode?.(true)
  }
  input.on('keypress', onKey)
  input.on('end', abort)
  input.on('close', abort)
  events.on('SIGINT', abort)
  if (closed) abort()
  else input.resume?.()
  return { signal: controller.signal, dispose() {
    input.off('keypress', onKey)
    input.off('end', abort)
    input.off('close', abort)
    events.off('SIGINT', abort)
    if (input.isTTY && !input.destroyed && !input.readableEnded) input.setRawMode?.(raw)
    if (paused) input.pause?.()
  } }
}

function waitState(state) {
  return {
    waiting: t('Waiting for Desktop to install…', '等待 Desktop 安装…'),
    source: t('Waiting for this local directory to be registered…', '等待登记当前本地目录；旧版本/其他来源不算完成…'),
    busy: t('Desktop is changing package files; waiting…', 'Desktop 正在修改包文件，等待安装结束…'),
    payload: t('Waiting for matching package files/version…', '等待包文件及版本匹配…'),
    manifest: t('Waiting for a complete Desktop profile…', '等待完整的 Desktop 安装记录…'),
    disabled: t('Installed; enable the bundle in Desktop to finish…', '已安装，请在 Desktop 中启用插件以完成接入…'),
    installed: t('Local package found; checking stable installation…', '已发现本地包，检查安装记录是否稳定…'),
    enabled: t('Enabled local package found; checking stable installation…', '已发现启用的本地包，检查安装记录是否稳定…'),
    runtime: t('Saved files found; owning-runtime verification has not passed…', '已发现保存的文件，但 Desktop 运行时来源验证尚未通过…'),
  }[state] ?? t('Waiting for Desktop…', '等待 Desktop…')
}

/** Last installer stage. Desktop UI owns install/enable; this side observes only. */
export async function runDshDesktopLocalInstall(clack, opts = {}, {
  sourcePath = dshDesktopLocalSource, desktopStatus = dshDesktopStatus,
  wait = waitForDshDesktopLocal, cancellation = desktopWaitCancellation,
} = {}) {
  const source = sourcePath()
  const status = desktopStatus()
  clack.note([
    t('1. Open DeepSeek Harness Desktop; keep it running.', '1. 打开 DeepSeek Harness Desktop，保持运行。'),
    t('2. Plugins → Add plugin.', '2. 进入「插件 → 添加插件」。'),
    t('3. Paste the directory below, then click Install.', '3. 粘贴下方完整目录，点击「安装」。'),
    t('4. Enable now if desired; follow Desktop restart instructions.', '4. 按需「立即启用」，遵循 Desktop 的重启提示。'),
    '',
    t('Keep this directory: Desktop may link to it.', '请保留此目录，Desktop 可能链接到它。'),
    t('Use the package directory, not cli.mjs or a profile directory.', '填写包目录，不是 cli.mjs 或 profile 目录。'),
    opts.enableDshBundle ? t('Explicit enable requested: also waiting for saved enablement.', '已要求显式启用，将同时等待启用状态。') : '',
    t('Saved installation/source only; live activation is not proven.', '仅检查保存的安装与来源，不代表实际加载。'),
  ].filter(Boolean).join('\n'), t('Desktop · local directory setup (last step)', 'Desktop · 本地目录接入（最后一步）'))
  // Never tildify, quote or replace the copyable absolute directory.
  clack.log.info(t('Local directory — copy the entire next line:', '本地目录 — 复制下面完整的一行：'))
  clack.log.message ? clack.log.message(source) : clack.log.info(source)
  clack.log.info(t(`Watching Desktop profile: ${status.profileDir}`, `检测 Desktop profile：${status.profileDir}`))
  if (opts.dryRun) {
    clack.log.info(t('dry-run: directory preview only; no waiting, profile writes or host commands.', 'dry-run：仅预览目录；不等待、不修改 profile、不执行宿主命令。'))
    return { ok: true, files: [], planned: true }
  }
  clack.log.info(t('Checking every second, up to 15 minutes. Esc / Ctrl+C stops only this wait; previous integrations remain.', '每秒检查，最多等待 15 分钟。Esc / Ctrl+C 仅停止这次等待，保留前面已完成的接入。'))
  const cancel = cancellation()
  // Clack 0.10's spinner calls block(), whose Escape/Ctrl+C handler exits the
  // whole process. Use non-intercepting status lines for this cancellable wait.
  clack.log.info(waitState('waiting'))
  let lastState = 'waiting'
  try {
    const result = await wait({ source, dir: status.profileDir, requireEnabled: !!opts.enableDshBundle,
      signal: cancel.signal, onState: state => {
        if (state !== lastState) { clack.log.info(waitState(state)); lastState = state }
      } })
    if (result.ok) {
      clack.log.success(t('Desktop local installation detected.', '已检测到 Desktop 本地目录安装完成。'))
      clack.log.success(t(`Desktop: v${result.dsh.version} → ${result.dsh.root}`, `Desktop：v${result.dsh.version} → ${result.dsh.root}`))
      if (result.dsh.verification === 'disk') clack.log.warn(t('Saved local installation verified; no bundled launcher found, so runtime resolution/loading is unverified.', '已核对保存的本地安装；未找到内置启动器，运行时解析与加载尚未验证。'))
      else clack.log.info(t('Owning-runtime source verified; live activation still requires Desktop confirmation/restart.', 'Desktop 自有运行时来源已验证；实际加载仍需在 Desktop 确认或重启。'))
      if (!result.dsh.enabled) clack.log.warn(t('Installed but disabled. Enable search-boost in Desktop when ready.', '已安装但未启用。需要使用时请在 Desktop 启用 search-boost。'))
      return result
    }
    clack.log.warn(t('Desktop setup remains unfinished.', 'Desktop 接入尚未完成。'))
    const error = result.verificationFailed
      ? t('Saved installation was found, but owning-runtime verification failed. Automatic retries stopped; check Desktop runtime/source and retry explicitly. Previous integrations were retained.', '已发现保存的安装，但 Desktop 运行时验证未通过。已停止自动重试；请检查 Desktop 运行时及来源后手动重试。前面已完成的接入已保留。')
      : result.cancelled
        ? t('Stopped waiting. Desktop installation was not confirmed; previous integrations were retained.', '已停止等待，尚未确认 Desktop 安装；前面已完成的接入已保留。')
        : t('Wait timed out. Check Desktop installation/enablement and retry; previous integrations were retained.', '等待超时。请检查 Desktop 安装/启用状态后重试；前面已完成的接入已保留。')
    clack.log.warn(error)
    return { ...result, error, files: [] }
  } catch (error) {
    clack.log.warn(t('Desktop installation was not confirmed.', '未能确认 Desktop 安装。'))
    throw error
  } finally { cancel.dispose() }
}
