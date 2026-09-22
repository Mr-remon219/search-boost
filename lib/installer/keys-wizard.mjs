import {
  CONFIG_KEY_NAMES,
  ENV_MAP,
  KEY_NAMES,
  PENDING_ENGINE_KEY_NAMES,
  RECOMMEND_ALL_KEYED_ENGINES,
  assertEngineNames,
  assertKeySlotNames,
  envKeyHint,
  keyStatus,
  keysFilePath,
  readEngineRouting,
  readKeys,
  readKeysFileDocument,
  readKeysRouting,
  resolveKeyedEngines,
  writeKeysFile,
} from '../keys.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'

/** `anysearch` is storable but has no adapter yet — say so wherever a key is shown. */
const isPendingEngineKey = (name) => PENDING_ENGINE_KEY_NAMES.includes(name)
const PENDING_KEYS_LABEL = PENDING_ENGINE_KEY_NAMES.map((name) => `${name} key`).join(', ')

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
  // Dry run: every persistence path below is skipped, but the wizard still shows
  // what it would do.
  const dryRun = Boolean(opts.dryRun)
  const wouldWrite = (message) => console.log(`dry-run: ${message}`)

  if (opts.show) {
    printKeyStatus()
    return
  }

  // Validate the entire operation before its single read-modify-write. A mixed
  // invocation must not silently drop flags, partially save keys, or differ in dry-run.
  const sets = Object.entries(opts.set ?? {})
  const unsets = opts.unset ?? []
  const hasRouting = opts.engines != null || opts.enable?.length || opts.disable?.length
  if (sets.length || unsets.length || hasRouting) {
    // --set/--unset accept every key slot (pending engines included); routing
    // flags stay limited to engines that can actually run.
    for (const [name, value] of sets) {
      assertKeySlotNames([name], '--set')
      if (typeof value !== 'string' || !value.trim()) throw new Error(`Empty value for ${name}`)
    }
    assertKeySlotNames(unsets, '--unset')
    assertEngineNames(opts.enable ?? [], '--enable')
    assertEngineNames(opts.disable ?? [], '--disable')
    if (sets.some(([name]) => unsets.includes(name))) throw new Error('Cannot --set and --unset the same key')
    if ((opts.enable ?? []).some((name) => opts.disable?.includes(name))) throw new Error('Cannot --enable and --disable the same engine')
    if (opts.engines != null && (opts.enable?.length || opts.disable?.length)) throw new Error('Use --engines or --enable/--disable, not both')
    const patch = Object.fromEntries(sets.map(([name, value]) => [name, value.trim()]))
    for (const name of unsets) patch[name] = undefined
    if (opts.engines != null) {
      patch.enabledEngines = opts.engines === 'all' ? null
        : assertEngineNames(opts.engines.split(',').map((s) => s.trim()).filter(Boolean), '--engines')
    } else if (opts.enable?.length || opts.disable?.length) {
      // Resolve against the prospective keys, not the values before --set.
      const enabled = new Set(resolveKeyedEngines({ ...readKeys(), ...patch }, readEngineRouting()))
      for (const name of opts.enable ?? []) enabled.add(name)
      for (const name of opts.disable ?? []) enabled.delete(name)
      patch.enabledEngines = [...enabled]
    }
    // A corrupt store must fail preflight in dry-run as well.
    readKeysFileDocument()
    if (dryRun) {
      wouldWrite(`would apply key/routing changes to ${tildify(keysFilePath())}; nothing written`)
      return
    }
    writeKeysFile(patch)
    console.log(`Saved key/routing changes to ${tildify(keysFilePath())}`)
    for (const name of unsets) {
      const hint = envKeyHint(name)
      if (hint) console.log(`Hint: ${hint}`)
    }
    return
  }

  if (opts.yes || !clack) return

  clack.log.info(`Keys are stored in ${tildify(keysFilePath())} (not in agent MCP configs).`)
  clack.log.info(`Env vars ${CONFIG_KEY_NAMES.map((name) => ENV_MAP[name]).join(' / ')} also work.`)
  clack.log.info('One keyed engine (exa, brave, or tavily) is enough for the api layer; all three improve fusion ranking.')
  if (PENDING_ENGINE_KEY_NAMES.length) {
    clack.log.info(`Stored-only key slot: ${PENDING_KEYS_LABEL} is written and masked like the rest, but stays out of api-layer routing until its engine adapter ships.`)
  }

  // Only changed keys are patched; keep unrelated concurrent edits intact.
  const patch = {}

  for (const name of CONFIG_KEY_NAMES) {
    const status = keyStatus()[name]
    const hint = status.source === 'file'
      ? `current: ${status.masked}`
      : status.source === 'env'
        ? `from env: ${status.masked}`
        : 'not set'

    const action = await clack.select({
      message: `${name}${isPendingEngineKey(name) ? ` [${hint.startsWith('not set') ? 'stored only, adapter pending' : 'stored only — not in the api pool yet'}]` : ''} (${hint})`,
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

  const keysAfter = { ...readKeys(), ...patch }
  // Routing only ever considers routable engines: a stored-only key must not
  // make the wizard open a pool decision it cannot honour.
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
      // Selecting an engine here is an explicit enable, so the write below also
      // clears any stale per-engine disable flag for the selected names.
      if (selected.length === 1) {
        clack.log.info(`Single-engine mode (${selected[0]}) is OK. ${RECOMMEND_ALL_KEYED_ENGINES}`)
      } else if (selected.length < KEY_NAMES.length) {
        clack.log.info(RECOMMEND_ALL_KEYED_ENGINES)
      }
    }
  }

  if (dryRun) {
    wouldWrite(`would set api-layer engines to: ${enabledEngines === null ? 'all configured' : (enabledEngines.join(', ') || '(none)')}`)
  } else {
    writeKeysFile({ ...patch, enabledEngines })
  }
  const pendingStored = PENDING_ENGINE_KEY_NAMES.filter((name) => Boolean(keysAfter[name]))
  if (pendingStored.length) {
    clack.log.info(`${pendingStored.join(', ')} stored; api-layer routing stays ${KEY_NAMES.join(', ')} until the adapter lands.`)
  }
  if (!dryRun) clack.log.success(`Saved ${tildify(keysFilePath())}`)
}

/** @returns {string[]} */
export function formatKeyStatusLines() {
  const routing = readKeysRouting()
  const lines = [`API keys (${CONFIG_KEY_NAMES.join(', ')})`, RULE]
  for (const name of CONFIG_KEY_NAMES) {
    const st = keyStatus()[name]
    const detail = st.source === 'missing' ? 'missing' : `${st.source}  ${st.masked}`
    const inPool = routing.enabledNames.includes(name)
    const routable = KEY_NAMES.includes(name)
    const poolTag = !routable || st.source === 'missing'
      ? ''
      : inPool
        ? '  enabled'
        : routing.summary.hasExplicitRouting
          ? '  disabled'
          : ''
    const pendingTag = routable || st.source === 'missing' ? '' : '  stored only (adapter pending)'
    lines.push(`  ${name.padEnd(10)} ${detail}${poolTag}${pendingTag}`)
  }
  if (routing.summary.configured > 0) {
    lines.push('', `Keyed pool: ${routing.summary.enabled}/${routing.summary.total} enabled (${routing.summary.enabledNames.join(', ') || 'none'})`)
    if (routing.summary.enabled > 0 && routing.summary.enabled < routing.summary.total) {
      lines.push(RECOMMEND_ALL_KEYED_ENGINES)
    }
  }
  const pendingStored = PENDING_ENGINE_KEY_NAMES.filter((name) => keyStatus()[name].source !== 'missing')
  if (pendingStored.length) {
    lines.push(`Stored, not in the api pool yet: ${pendingStored.join(', ')}`)
  }
  lines.push('', `File: ${tildify(keysFilePath())}`)
  return lines
}

export function printKeyStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
}
