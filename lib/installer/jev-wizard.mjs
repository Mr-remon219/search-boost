import {
  JEV_DEFAULT_BASE_URL,
  JEV_ENV_API_KEY,
  JEV_KEY_URL,
  clearJevConfig,
  jevFilePath,
  jevStatus,
  normalizeJevBaseUrl,
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
  if (opts.show) {
    printJevStatus()
    return
  }

  if (opts.clear) {
    clearJevConfig()
    console.log(`Removed Jev credentials from ${tildify(jevFilePath())}`)
    return
  }

  if (opts.setBaseUrl != null || opts.setApiKey != null) {
    const saved = saveJevConfig({ baseUrl: opts.setBaseUrl ?? undefined, apiKey: opts.setApiKey ?? undefined })
    console.log(`Saved Jev credentials → ${tildify(jevFilePath())} (base URL ${saved.baseUrl})`)
    return
  }

  if (opts.yes || !clack) return

  const status = jevStatus()
  clack.log.info('Jev (experimental) is TypeSafe\'s System One model: typed decisions with probabilities instead of prose.')
  clack.log.info('With credentials set, the optional adaptive_search tool uses Jev to pick engines, judge collected evidence and decide per-question coverage.')
  clack.log.info('adaptive_search sends question text and the necessary evidence fragments to the configured Jev service (default TypeSafe); engine keys never leave search-boost.')
  clack.log.info(`Stored with the engine keys in ${tildify(jevFilePath())} (never written to agent configs).`)
  clack.log.info(`Env fallback: ${JEV_ENV_API_KEY} · get a key at ${JEV_KEY_URL}`)
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
  if (status.source === 'env') lines.push(`Env:  ${JEV_ENV_API_KEY} (no local copy in the keys file)`)
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
  console.log(`  ${'apiKey'.padEnd(8)} not configured — ${JEV_ENV_API_KEY} is also read`)
  console.log(`File: ${tildify(jevFilePath())}`)
}
