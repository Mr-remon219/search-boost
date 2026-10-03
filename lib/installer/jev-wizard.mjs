import { t, credentialSource } from './i18n.mjs'
import {
  JEV_DEFAULT_BASE_URL,
  JEV_KEY_URL,
  clearJevConfig,
  jevFilePath,
  jevStatus,
  normalizeJevBaseUrl,
  readJevConfig,
  saveJevConfig,
} from '../jev-config.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'

/**
 * Jev credentials (experimental) — endpoint + API key for TypeSafe's System One model.
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 * @param {{
 *   yes?: boolean,
 *   show?: boolean,
 *   setBaseUrl?: string | null,
 *   setApiKey?: string | null,
 *   clear?: boolean,
 * }} opts
 */
export async function runJevWizard(clack, opts = {}) {
  // Dry run: no credential write.
  const dryRun = Boolean(opts.dryRun)
  const wouldWrite = (message) => console.log(`dry-run: ${message}`)

  if (opts.show) {
    printJevStatus()
    return
  }

  if (opts.clear) {
    if (dryRun) wouldWrite(`would remove Jev credentials from ${tildify(jevFilePath())}`)
    else clearJevConfig()
    if (!dryRun) console.log(t(`Removed Jev credentials from ${tildify(jevFilePath())}`, `已移除 ${tildify(jevFilePath())} 中的 Jev 凭据`))
    return
  }

  if (opts.setBaseUrl != null || opts.setApiKey != null) {
    if (dryRun) {
      // Validate the inputs exactly like the real save, but write nothing.
      const current = readJevConfig()
      const baseUrl = normalizeJevBaseUrl(opts.setBaseUrl ?? current.baseUrl)
      const apiKey = String(opts.setApiKey ?? current.apiKey ?? '').trim()
      if (!apiKey) throw new Error('Jev API key is required — `search-boost config jev --jev-api-key <key>` or TUI → Jev credentials (experimental)')
      wouldWrite(`would save Jev credentials → ${tildify(jevFilePath())} (base URL ${baseUrl})`)
      return
    }
    const saved = saveJevConfig({ baseUrl: opts.setBaseUrl ?? undefined, apiKey: opts.setApiKey ?? undefined })
    console.log(t(`Saved Jev credentials → ${tildify(jevFilePath())} (base URL ${saved.baseUrl})`, `已保存 Jev 凭据 → ${tildify(jevFilePath())}（Base URL ${saved.baseUrl}）`))
    return
  }

  if (opts.yes || !clack) return

  const status = jevStatus()
  clack.log.info(t('Jev (experimental) is TypeSafe\'s System One model: typed decisions with probabilities instead of prose.', "Jev（实验性）是 TypeSafe 的 System One 模型：输出带概率的结构化决策，而非自然语言说明。"))
  clack.log.info(t('With credentials set, the optional adaptive_search tool uses one Jev strategy request plus fixed-option screening to pick the ranking preset (and the community branch when omitted), review one bounded fused snapshot and return only safe value 3/4/5 material with pagination.', "配置凭据后，可选工具 adaptive_search 用一次 Jev 策略请求加固定选项筛选：选择排序预设（省略 community 时兼选社区支路）、审阅一份有界 fused 快照，并分页返回安全且价值 3/4/5 的材料。"))
  clack.log.info(t('adaptive_search sends question text, search intent and necessary fragments to the configured Jev service (default TypeSafe); engine keys never leave search-boost.', "adaptive_search 会将问题文本、搜索意图和必要片段发送到配置的 Jev 服务（默认 TypeSafe）；搜索引擎 Keys 不会发送给 Jev。"))
  clack.log.info(t(`Stored in ${tildify(jevFilePath())} (never written to agent configs).`, `保存在 ${tildify(jevFilePath())}，不会写入 Agent 配置。`))
  clack.log.info(t(`TypeSafe keys: ${JEV_KEY_URL}; Vercel AI Gateway: use https://ai-gateway.vercel.sh/v1 + its key.`, `TypeSafe Key：${JEV_KEY_URL}；Vercel AI Gateway：使用 https://ai-gateway.vercel.sh/v1 及其 Key。`))
  clack.log.info(`${t('Current:', '当前：')} ${status.configured ? `${status.baseUrl} · ${status.masked}` : t('not configured', '未配置')}`)

  const action = await clack.select({
    message: t('Jev credentials (experimental)', "Jev 配置（实验性）"),
    options: [
      { value: 'keep', label: t('Keep as-is', "保持不变") },
      { value: 'set', label: t('Set base URL + API key', "设置 Base URL 与 API Key") },
      { value: 'remove', label: t('Remove from file', "从文件中移除"), disabled: status.source !== 'file' },
    ],
    initialValue: status.configured ? 'keep' : 'set',
  })
  handleCancel(action, clack)

  if (action === 'keep') return

  if (action === 'remove') {
    if (dryRun) {
      clack.log.info(t(`dry-run: would remove Jev credentials from ${tildify(jevFilePath())}`, `dry-run：将移除 ${tildify(jevFilePath())} 中的 Jev 凭据`))
      return
    }
    clearJevConfig()
    clack.log.success(t(`Removed Jev credentials from ${tildify(jevFilePath())}`, `已移除 ${tildify(jevFilePath())} 中的 Jev 凭据`))
    return
  }

  const baseUrl = await clack.text({
    message: t('Jev base URL', "Jev Base URL"),
    placeholder: JEV_DEFAULT_BASE_URL,
    defaultValue: status.baseUrl,
    validate: (v) => {
      try {
        normalizeJevBaseUrl(v)
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    },
  })
  handleCancel(baseUrl, clack)

  const apiKey = await clack.password({
    message: status.source === 'file' ? t(`Jev API key (Enter keeps ${status.masked})`, `Jev API Key（Enter 保留 ${status.masked}）`) : t('Jev API key', 'Jev API Key'),
    validate: (v) => {
      if (!String(v ?? '').trim() && status.source !== 'file') return t('API key cannot be empty', "API Key 不能为空")
    },
  })
  handleCancel(apiKey, clack)

  if (dryRun) {
    // Validate the inputs like the real save, but write nothing.
    normalizeJevBaseUrl(String(baseUrl ?? '').trim() || status.baseUrl)
    clack.log.info(t(`dry-run: would save Jev credentials → ${tildify(jevFilePath())}`, `dry-run：将保存 Jev 凭据 → ${tildify(jevFilePath())}`))
    return
  }

  const saved = saveJevConfig({
    baseUrl: String(baseUrl ?? '').trim() || status.baseUrl,
    apiKey: String(apiKey ?? '').trim() || undefined,
  })
  clack.log.success(t(`Saved Jev credentials → ${tildify(jevFilePath())} (base URL ${saved.baseUrl})`, `已保存 Jev 凭据 → ${tildify(jevFilePath())}（Base URL ${saved.baseUrl}）`))
}

/**
 * Status lines for the Jev block. Empty when Jev is not configured, so the
 * default status output stays quiet for users who never enable it.
 * @returns {string[]}
 */
export function formatJevStatusLines() {
  const status = jevStatus()
  if (!status.configured) return []
  const lines = [t('Jev (experimental)', "Jev（实验性）"), RULE]
  lines.push(`  ${'baseUrl'.padEnd(8)} ${status.baseUrl}${status.baseUrlStored ? '' : t('  (default)', '  （默认）')}`)
  lines.push(`  ${'apiKey'.padEnd(8)} ${credentialSource(status.source)}  ${status.masked}`)
  lines.push('')
  lines.push(t(`File: ${tildify(jevFilePath())}`, `文件：${tildify(jevFilePath())}`))
  return lines
}

export function printJevStatus() {
  const lines = formatJevStatusLines()
  if (lines.length) {
    for (const line of lines) console.log(line)
    return
  }
  console.log(t('Jev (experimental)', "Jev（实验性）"), RULE)
  console.log(`  ${'baseUrl'.padEnd(8)} ${JEV_DEFAULT_BASE_URL}  (default)`)
  console.log(`  ${'apiKey'.padEnd(8)} not configured — save one with \`search-boost config jev\``)
  console.log(t(`File: ${tildify(jevFilePath())}`, `文件：${tildify(jevFilePath())}`))
}
