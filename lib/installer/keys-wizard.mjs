import {
  KEY_NAMES,
  envKeyHint,
  keyStatus,
  keysFilePath,
  readKeysFile,
  setKey,
  unsetKey,
  writeKeysFile,
} from '../keys.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'

/**
 * @param {import('@clack/prompts').ClackPrompter} clack
 * @param {{ yes?: boolean, show?: boolean, set?: Record<string, string>, unset?: string[] }} opts
 */
export async function runKeysWizard(clack, opts = {}) {
  if (opts.show) {
    printKeyStatus()
    return
  }

  if (opts.set && Object.keys(opts.set).length > 0) {
    for (const [name, value] of Object.entries(opts.set)) setKey(name, value)
    console.log(`Saved keys to ${tildify(keysFilePath())}`)
    return
  }

  if (opts.unset?.length) {
    for (const name of opts.unset) {
      unsetKey(name)
      const hint = envKeyHint(name)
      if (hint) console.log(`Hint: ${hint}`)
    }
    console.log(`Removed: ${opts.unset.join(', ')}`)
    return
  }

  if (opts.yes) return

  clack.log.info(`Keys are stored in ${tildify(keysFilePath())} (not in agent MCP configs).`)
  clack.log.info('Env vars TAVILY_API_KEY / BRAVE_API_KEY / EXA_API_KEY also work.')

  const fileKeys = readKeysFile()
  const patch = { ...fileKeys }

  for (const name of KEY_NAMES) {
    const status = keyStatus()[name]
    const hint = status.source === 'file'
      ? `current: ${status.masked}`
      : status.source === 'env'
        ? `from env: ${status.masked}`
        : 'not set'

    const action = await clack.select({
      message: `${name} (${hint})`,
      options: [
        { value: 'keep', label: 'Keep as-is' },
        { value: 'set', label: 'Set / replace' },
        { value: 'remove', label: 'Remove from file' },
      ],
      initialValue: status.source === 'missing' ? 'set' : 'keep',
    })
    handleCancel(action, clack)

    if (action === 'keep') continue
    if (action === 'remove') {
      patch[name] = undefined
      continue
    }

    const value = await clack.password({
      message: `${name} API key`,
      validate: (v) => {
        if (!v?.trim()) return 'Key cannot be empty (choose Remove to clear)'
      },
    })
    handleCancel(value, clack)
    patch[name] = String(value).trim()
  }

  writeKeysFile(patch)
  clack.log.success(`Saved ${tildify(keysFilePath())}`)
}

/** @returns {string[]} */
export function formatKeyStatusLines() {
  const lines = [`API keys (${KEY_NAMES.join(', ')})`, RULE]
  for (const [name, st] of Object.entries(keyStatus())) {
    const detail = st.source === 'missing' ? 'missing' : `${st.source}  ${st.masked}`
    lines.push(`  ${name.padEnd(8)} ${detail}`)
  }
  lines.push('', `File: ${tildify(keysFilePath())}`)
  return lines
}

export function printKeyStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
}
