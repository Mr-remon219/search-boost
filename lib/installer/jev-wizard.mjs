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
    if (!dryRun) console.log(`Removed Jev credentials from ${tildify(jevFilePath())}`)
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
    console.log(`Saved Jev credentials → ${tildify(jevFilePath())} (base URL ${saved.baseUrl})`)
    return
  }

  if (opts.yes || !clack) return

  const status = jevStatus()
  clack.log.info('Jev (experimental) is TypeSafe\'s System One model: typed decisions with probabilities instead of prose.')
  clack.log.info('With credentials set, the optional adaptive_search tool uses Jev to pick engines, judge evidence and return approved URLs/descriptions with pagination.')
  clack.log.info('adaptive_search sends question text and the necessary evidence fragments to the configured Jev service (default TypeSafe); engine keys never leave search-boost.')
  clack.log.info(`Stored in ${tildify(jevFilePath())} (never written to agent configs).`)
  clack.log.info(`TypeSafe keys: ${JEV_KEY_URL}; Vercel AI Gateway: use https://ai-gateway.vercel.sh/v1 + its key.`)
  clack.log.info(`Current: ${status.configured ? `${status.baseUrl} · ${status.masked}` : 'not configured'}`)

  const action = await clack.select({
    message: 'Jev credentials (experimental)',
    options: [
      { value: 'keep', label: 'Keep as-is' },
      { value: 'set', label: 'Set base URL + API key' },
      { value: 'remove', label: 'Remove from file', disabled: status.source !== 'file' },
    ],
    initialValue: status.configured ? 'keep' : 'set',
  })
  handleCancel(action, clack)

  if (action === 'keep') return

  if (action === 'remove') {
    if (dryRun) {
      clack.log.info(`dry-run: would remove Jev credentials from ${tildify(jevFilePath())}`)
      return
    }
    clearJevConfig()
    clack.log.success(`Removed Jev credentials from ${tildify(jevFilePath())}`)
    return
  }

  const baseUrl = await clack.text({
    message: 'Jev base URL',
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
    message: status.source === 'file' ? `Jev API key (Enter keeps ${status.masked})` : 'Jev API key',
    validate: (v) => {
      if (!String(v ?? '').trim() && status.source !== 'file') return 'API key cannot be empty'
    },
  })
  handleCancel(apiKey, clack)

  if (dryRun) {
    // Validate the inputs like the real save, but write nothing.
    normalizeJevBaseUrl(String(baseUrl ?? '').trim() || status.baseUrl)
    clack.log.info(`dry-run: would save Jev credentials → ${tildify(jevFilePath())}`)
    return
  }

  const saved = saveJevConfig({
    baseUrl: String(baseUrl ?? '').trim() || status.baseUrl,
    apiKey: String(apiKey ?? '').trim() || undefined,
  })
  clack.log.success(`Saved Jev credentials → ${tildify(jevFilePath())} (base URL ${saved.baseUrl})`)
}

/**
 * Status lines for the Jev block. Empty when Jev is not configured, so the
 * default status output stays quiet for users who never enable it.
 * @returns {string[]}
 */
export function formatJevStatusLines() {
  const status = jevStatus()
  if (!status.configured) return []
  const lines = ['Jev (experimental)', RULE]
  lines.push(`  ${'baseUrl'.padEnd(8)} ${status.baseUrl}${status.baseUrlStored ? '' : '  (default)'}`)
  lines.push(`  ${'apiKey'.padEnd(8)} ${status.source}  ${status.masked}`)
  lines.push('')
  lines.push(`File: ${tildify(jevFilePath())}`)
  return lines
}

export function printJevStatus() {
  const lines = formatJevStatusLines()
  if (lines.length) {
    for (const line of lines) console.log(line)
    return
  }
  console.log('Jev (experimental)', RULE)
  console.log(`  ${'baseUrl'.padEnd(8)} ${JEV_DEFAULT_BASE_URL}  (default)`)
  console.log(`  ${'apiKey'.padEnd(8)} not configured — save one with \`search-boost config jev\``)
  console.log(`File: ${tildify(jevFilePath())}`)
}
