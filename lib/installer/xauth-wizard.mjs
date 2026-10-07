import { t, credentialSource, xAuthDetail } from './i18n.mjs'
import {
  authStatus,
  grokAuthFile,
  importApiKey,
  importFromGrok,
  logout,
  piAuthPath,
  readGrokAuth,
  readPiAuth,
} from '../search/x/xauth.js'
import { handleCancel, RULE, tildify } from './ui.mjs'

/**
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 * @param {{
 *   yes?: boolean,
 *   show?: boolean,
 *   importGrok?: boolean,
 *   setXaiKey?: string | null,
 *   logout?: boolean,
 * }} opts
 */
export async function runXAuthWizard(clack, opts = {}) {
  // Dry run: no credential write, no grok import, no logout.
  const dryRun = Boolean(opts.dryRun)
  const wouldWrite = (message) => console.log(`dry-run: ${message}`)

  if ([opts.importGrok, opts.setXaiKey != null, opts.logout].filter(Boolean).length > 1) throw new Error('Choose only one X credential operation')

  if (opts.show) {
    printXAuthStatus()
    return
  }

  if (opts.importGrok) {
    if (dryRun) wouldWrite(`would import the grok login → ${tildify(piAuthPath())}`)
    importFromGrok({ dryRun })
    if (!dryRun) console.log(t(`Imported grok login → ${tildify(piAuthPath())}`, `已导入 Grok 登录 → ${tildify(piAuthPath())}`))
    return
  }

  if (opts.setXaiKey != null) {
    if (dryRun) wouldWrite(`would save an XAI API key → ${tildify(piAuthPath())}`)
    importApiKey(opts.setXaiKey, { dryRun })
    if (!dryRun) console.log(`Saved XAI API key → ${tildify(piAuthPath())}`)
    return
  }

  if (opts.logout) {
    const removed = dryRun ? false : logout()
    console.log(
      dryRun
        ? t(`dry-run: would remove the local xauth copy (${tildify(piAuthPath())})`, `dry-run：将移除本地 X 凭据副本（${tildify(piAuthPath())}）`)
        : removed
          ? `Removed local xauth copy (${tildify(piAuthPath())})`
          : t('No local xauth copy to remove', "没有可移除的本地 X 凭据副本"),
    )
    return
  }

  if (opts.yes || !clack) return

  const status = authStatus()
  clack.log.info(t('X search works without an X/xAI API key or paid API subscription through a keyless fallback (best-effort; coverage may be incomplete). Credentials are optional and only enable the official channel.', 'X 搜索无需先配置 X/xAI API Key 或付费 API 订阅，可使用免凭据备用检索（尽力获取，覆盖可能不完整）。凭据仅用于可选的官方通道。'))
  clack.log.info(t('Priority: XAI_API_KEY env → local copy → grok login (not auto-imported).', "凭据优先级：XAI_API_KEY 环境变量 → 本地副本 → Grok 登录（不会自动导入）。"))
  clack.log.info(t(`Local copy: ${tildify(piAuthPath())} (MCP /x-login and config x write here)`, `本地副本：${tildify(piAuthPath())}（MCP /x-login 与 config x 均写入此处）`))
  clack.log.info(t(`Grok login: ${tildify(grokAuthFile())}`, `Grok 登录：${tildify(grokAuthFile())}`))
  clack.log.info(t(`Current: ${status.detail}`, `当前：${xAuthDetail(status)}`))

  const grokAvailable = Boolean(readGrokAuth())
  const hasLocal = Boolean(readPiAuth()?.key)

  const action = await clack.select({
    message: t('X credentials', "X 凭据"),
    options: [
      { value: 'keep', label: t('Keep as-is', "保持不变") },
      {
        value: 'import-grok',
        label: t('Import from grok login', "从 Grok 登录导入"),
        hint: grokAvailable ? t('session found', "已找到登录会话") : t('run grok login first', "请先运行 grok login"),
        disabled: !grokAvailable,
      },
      { value: 'set-key', label: t('Set XAI API key', "设置 XAI API Key") },
      {
        value: 'remove',
        label: t('Remove local copy', "移除本地副本"),
        disabled: !hasLocal && status.source !== 'local',
      },
    ],
    initialValue: (status.source === 'none' || status.source === 'grok-pending') && grokAvailable ? 'import-grok' : 'keep',
  })
  handleCancel(action, clack)

  switch (action) {
    case 'keep':
      return
    case 'import-grok': {
      if (dryRun) {
        importFromGrok({ dryRun: true })
        clack.log.info(t(`dry-run: would import the grok login → ${tildify(piAuthPath())}`, `dry-run：将导入 Grok 登录 → ${tildify(piAuthPath())}`))
        return
      }
      try {
        importFromGrok()
        clack.log.success(t(`Imported grok login → ${tildify(piAuthPath())}`, `已导入 Grok 登录 → ${tildify(piAuthPath())}`))
      } catch (err) {
        clack.log.error(err instanceof Error ? err.message : String(err))
      }
      return
    }
    case 'set-key': {
      const value = await clack.password({
        message: t('XAI API key (starts with xai-)', "XAI API Key（以 xai- 开头）"),
        validate: (v) => {
          if (!v?.trim()) return t('Key cannot be empty', "Key 不能为空")
          if (!String(v).trim().startsWith('xai-')) return t('Must start with xai- (get one at console.x.ai)', "必须以 xai- 开头（可在 console.x.ai 获取）。")
        },
      })
      handleCancel(value, clack)
      if (dryRun) {
        clack.log.info(t(`dry-run: would save an XAI API key → ${tildify(piAuthPath())}`, `dry-run：将保存 XAI API Key → ${tildify(piAuthPath())}`))
        return
      }
      importApiKey(String(value).trim())
      clack.log.success(t(`Saved → ${tildify(piAuthPath())}`, `已保存 → ${tildify(piAuthPath())}`))
      return
    }
    case 'remove': {
      if (dryRun) {
        clack.log.info(t(`dry-run: would remove the local xauth copy (${tildify(piAuthPath())})`, `dry-run：将移除本地 X 凭据副本（${tildify(piAuthPath())}）`))
        return
      }
      const removed = logout()
      if (removed) clack.log.success(t('Removed local xauth copy', "已移除本地 X 凭据副本"))
      else clack.log.info(t('No local xauth copy to remove', "没有可移除的本地 X 凭据副本"))
      return
    }
    default:
      return
  }
}

/** @returns {string[]} */
export function formatXAuthStatusLines() {
  const status = authStatus()
  const lines = [t('X credentials (x_search)', 'X 凭据（x_search）'), RULE]
  lines.push(`  ${credentialSource(status.source).padEnd(12)} ${xAuthDetail(status)}`)
  lines.push(t('  X/xAI API credentials are optional; keyless fallback remains available (best-effort).', '  X/xAI API 凭据为可选项；可使用免凭据备用检索（尽力获取）。'))
  if (status.source === 'grok-pending') {
    lines.push(t('  ! Official x_search not enabled — run search-boost config x --import-grok', '  ! 官方 x_search 尚未启用 — 请运行 search-boost config x --import-grok'))
  }
  lines.push('')
  lines.push(t(`Local: ${tildify(piAuthPath())}`, `本地：${tildify(piAuthPath())}`))
  lines.push(t(`Grok:  ${tildify(grokAuthFile())}`, `Grok：${tildify(grokAuthFile())}`))
  lines.push(t('Note:  MCP /x-login and search-boost config x write the same local copy', '提示：MCP /x-login 与 search-boost config x 写入相同的本地副本'))
  const envKey = process.env.XAI_API_KEY
  if (envKey?.startsWith('xai-')) {
    lines.push(t('Env:   XAI_API_KEY (highest priority)', '环境变量：XAI_API_KEY（最高优先级）'))
  } else if (envKey) {
    lines.push(t('Env:   XAI_API_KEY set but ignored (must start with xai-)', '环境变量：XAI_API_KEY 已设置但被忽略（必须以 xai- 开头）'))
  }
  return lines
}

export function printXAuthStatus() {
  for (const line of formatXAuthStatusLines()) console.log(line)
}
