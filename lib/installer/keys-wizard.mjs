import {
  KEY_NAMES,
  RECOMMEND_ALL_KEYED_ENGINES,
  envKeyHint,
  keyStatus,
  keysFilePath,
  readEngineRouting,
  readKeys,
  readKeysFile,
  readKeysRouting,
  resolveKeyedEngines,
  setEnabledEngines,
  setKey,
  unsetKey,
  writeKeysFile,
} from '../keys.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'

/**
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 * @param {{
 *   yes?: boolean,
 *   show?: boolean,
 *   set?: Record<string, string>,
 *   unset?: string[],
 *   engines?: string | null,
 *   enable?: string[],
 *   disable?: string[],
 * }} opts
 */
export async function runKeysWizard(clack, opts = {}) {
  if (opts.show) {
    printKeyStatus()
    return
  }

  if (opts.engines !== undefined && opts.engines !== null) {
    if (opts.engines === 'all') {
      setEnabledEngines(null)
      console.log('Cleared enabledEngines — all configured keys will be used on the api layer.')
    } else {
      const names = opts.engines.split(',').map((s) => s.trim()).filter(Boolean)
      setEnabledEngines(names)
      console.log(`Enabled api-layer engines: ${names.join(', ')}`)
    }
    return
  }

  if (opts.enable?.length || opts.disable?.length) {
    const routing = readEngineRouting()
    const keys = readKeys()
    const enabled = new Set(resolveKeyedEngines(keys, routing))
    if (routing.enabledEngines === undefined) {
      for (const name of KEY_NAMES) {
        if (keys[name]) enabled.add(name)
      }
    }
    for (const name of opts.enable ?? []) {
      if (KEY_NAMES.includes(name)) enabled.add(name)
    }
    for (const name of opts.disable ?? []) {
      enabled.delete(name)
    }
    setEnabledEngines([...enabled])
    console.log(`Enabled api-layer engines: ${[...enabled].join(', ') || '(none)'}`)
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

  if (opts.yes || !clack) return

  clack.log.info(`Keys are stored in ${tildify(keysFilePath())} (not in agent MCP configs).`)
  clack.log.info('Env vars TAVILY_API_KEY / BRAVE_API_KEY / EXA_API_KEY also work.')
  clack.log.info('One keyed engine (exa, brave, or tavily) is enough for the api layer; all three improve fusion ranking.')

  const fileKeys = readKeysFile()
  /** @type {Partial<Record<string, string | undefined>>} */
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

  const keysAfter = readKeys()
  const configured = KEY_NAMES.filter((name) => Boolean(keysAfter[name]))
  /** @type {string[] | null} */
  let enabledEngines = null

  if (configured.length > 0) {
    const routing = readEngineRouting()
    const initial = resolveKeyedEngines(keysAfter, routing)
    const initialValues = initial.length > 0 ? initial : configured

    const selected = await clack.multiselect({
      message: 'Which keyed engines should search-boost use on the api layer?',
      options: KEY_NAMES.map((name) => ({
        value: name,
        label: name,
        hint: keysAfter[name] ? 'key configured' : 'no key',
        disabled: !keysAfter[name],
      })),
      initialValues: initialValues.filter((name) => keysAfter[name]),
      required: false,
    })
    handleCancel(selected, clack)

    if (selected.length === 0) {
      clack.log.warn('No engines selected — api layer will fall back to free engines until you enable at least one keyed engine.')
      enabledEngines = []
    } else {
      enabledEngines = /** @type {string[]} */ (selected)
      if (selected.length === 1) {
        clack.log.info(`Single-engine mode (${selected[0]}) is OK. ${RECOMMEND_ALL_KEYED_ENGINES}`)
      } else if (selected.length < KEY_NAMES.length) {
        clack.log.info(RECOMMEND_ALL_KEYED_ENGINES)
      }
    }
  }

  writeKeysFile({ enabledEngines })
  clack.log.success(`Saved ${tildify(keysFilePath())}`)
}

/** @returns {string[]} */
export function formatKeyStatusLines() {
  const routing = readKeysRouting()
  const lines = [`API keys (${KEY_NAMES.join(', ')})`, RULE]
  for (const name of KEY_NAMES) {
    const st = keyStatus()[name]
    const detail = st.source === 'missing' ? 'missing' : `${st.source}  ${st.masked}`
    const inPool = routing.enabledNames.includes(name)
    const poolTag = st.source === 'missing'
      ? ''
      : inPool
        ? '  enabled'
        : routing.summary.hasExplicitRouting
          ? '  disabled'
          : ''
    lines.push(`  ${name.padEnd(8)} ${detail}${poolTag}`)
  }
  if (routing.summary.configured > 0) {
    lines.push('', `Keyed pool: ${routing.summary.enabled}/${routing.summary.total} enabled (${routing.summary.enabledNames.join(', ') || 'none'})`)
    if (routing.summary.enabled > 0 && routing.summary.enabled < routing.summary.total) {
      lines.push(RECOMMEND_ALL_KEYED_ENGINES)
    }
  }
  lines.push('', `File: ${tildify(keysFilePath())}`)
  return lines
}

export function printKeyStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
}
