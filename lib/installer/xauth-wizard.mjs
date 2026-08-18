import {
  authStatus,
  grokAuthFile,
  importApiKey,
  importFromGrok,
  logout,
  piAuthPath,
  readGrokAuth,
  readPiAuth,
} from '../search/xauth.js'
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
  if (opts.show) {
    printXAuthStatus()
    return
  }

  if (opts.importGrok) {
    importFromGrok()
    console.log(`Imported grok login → ${tildify(piAuthPath())}`)
    return
  }

  if (opts.setXaiKey != null) {
    importApiKey(opts.setXaiKey)
    console.log(`Saved XAI API key → ${tildify(piAuthPath())}`)
    return
  }

  if (opts.logout) {
    const removed = logout()
    console.log(
      removed
        ? `Removed local xauth copy (${tildify(piAuthPath())})`
        : 'No local xauth copy to remove',
    )
    return
  }

  if (opts.yes || !clack) return

  const status = authStatus()
  clack.log.info('X credentials enable official x_search (optional).')
  clack.log.info('Priority: XAI_API_KEY env → local copy → grok login (not auto-imported).')
  clack.log.info(`Local copy: ${tildify(piAuthPath())} (MCP /x-login and config x write here)`)
  clack.log.info(`Grok login: ${tildify(grokAuthFile())}`)
  clack.log.info(`Current: ${status.detail}`)

  const grokAvailable = Boolean(readGrokAuth())
  const hasLocal = Boolean(readPiAuth()?.key)

  const action = await clack.select({
    message: 'X credentials',
    options: [
      { value: 'keep', label: 'Keep as-is' },
      {
        value: 'import-grok',
        label: 'Import from grok login',
        hint: grokAvailable ? 'session found' : 'run grok login first',
        disabled: !grokAvailable,
      },
      { value: 'set-key', label: 'Set XAI API key' },
      {
        value: 'remove',
        label: 'Remove local copy',
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
      try {
        importFromGrok()
        clack.log.success(`Imported grok login → ${tildify(piAuthPath())}`)
      } catch (err) {
        clack.log.error(err instanceof Error ? err.message : String(err))
      }
      return
    }
    case 'set-key': {
      const value = await clack.password({
        message: 'XAI API key (starts with xai-)',
        validate: (v) => {
          if (!v?.trim()) return 'Key cannot be empty'
          if (!String(v).trim().startsWith('xai-')) return 'Must start with xai- (get one at console.x.ai)'
        },
      })
      handleCancel(value, clack)
      importApiKey(String(value).trim())
      clack.log.success(`Saved → ${tildify(piAuthPath())}`)
      return
    }
    case 'remove': {
      const removed = logout()
      if (removed) clack.log.success('Removed local xauth copy')
      else clack.log.info('No local xauth copy to remove')
      return
    }
    default:
      return
  }
}

/** @returns {string[]} */
export function formatXAuthStatusLines() {
  const status = authStatus()
  const lines = ['X credentials (x_search)', RULE]
  lines.push(`  ${status.source.padEnd(12)} ${status.detail}`)
  if (status.source === 'grok-pending') {
    lines.push('  ! Official x_search not enabled — run search-boost config x --import-grok')
  }
  lines.push('')
  lines.push(`Local: ${tildify(piAuthPath())}`)
  lines.push(`Grok:  ${tildify(grokAuthFile())}`)
  lines.push('Note:  MCP /x-login and search-boost config x write the same local copy')
  const envKey = process.env.XAI_API_KEY
  if (envKey?.startsWith('xai-')) {
    lines.push('Env:   XAI_API_KEY (highest priority)')
  } else if (envKey) {
    lines.push('Env:   XAI_API_KEY set but ignored (must start with xai-)')
  }
  return lines
}

export function printXAuthStatus() {
  for (const line of formatXAuthStatusLines()) console.log(line)
}
