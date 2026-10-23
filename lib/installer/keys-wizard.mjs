import { t, credentialSource, TuiCancelled, TuiExit } from './i18n.mjs'
import { ENGINE_BASE_URLS, engineSearchUrl, normalizeEngineBaseUrl } from '../engine-endpoints.mjs'
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
  readEngineBaseUrls,
  readKeys,
  readKeysFileDocument,
  readKeysRouting,
  resolveKeyedEngines,
  writeKeysFile,
} from '../keys.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'

/** Future stored-only credentials remain visibly distinct from runnable engines. */
const isPendingEngineKey = (name) => PENDING_ENGINE_KEY_NAMES.includes(name)
const PENDING_KEYS_LABEL = PENDING_ENGINE_KEY_NAMES.map((name) => `${name} key`).join(', ')

/**
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 * @param {{
 *   yes?: boolean,
 *   show?: boolean,
 *   set?: Record<string, string>,
 *   unset?: string[],
 *   baseUrls?: Record<string, string>,
 *   resetBaseUrls?: string[],
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
  const baseUrls = { ...opts.baseUrls }
  const resets = opts.resetBaseUrls ?? []
  assertEngineNames(Object.keys(baseUrls), '--base-url')
  assertEngineNames(resets, '--reset-base-url')
  for (const name of resets) {
    if (name in baseUrls) throw new Error('Cannot set and reset the same base URL')
    baseUrls[name] = null
  }
  for (const [name, value] of Object.entries(baseUrls)) {
    if (value !== null) baseUrls[name] = normalizeEngineBaseUrl(value)
  }
  if (sets.length || unsets.length || hasRouting || Object.keys(baseUrls).length) {
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
    if (Object.keys(baseUrls).length) patch.baseUrls = baseUrls
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
      wouldWrite(`would apply key/routing/base URL changes to ${tildify(keysFilePath())}; nothing written`)
      return
    }
    writeKeysFile(patch)
    console.log(`Saved key/routing/base URL changes to ${tildify(keysFilePath())}`)
    for (const name of unsets) {
      const hint = envKeyHint(name)
      if (hint) console.log(`Hint: ${hint}`)
    }
    return
  }

  if (opts.yes || !clack) return

  clack.log.info(t(`Keys are stored in ${tildify(keysFilePath())} (not in agent MCP configs).`, `Keys 保存在 ${tildify(keysFilePath())}，不会写入 Agent 的 MCP 配置。`))
  clack.log.info(t(`Env vars ${CONFIG_KEY_NAMES.map((name) => ENV_MAP[name]).join(' / ')} also work.`, `也可使用环境变量 ${CONFIG_KEY_NAMES.map((name) => ENV_MAP[name]).join(' / ')}。`))
  clack.log.info(t('AnySearch uses anonymous quota in free, a key in api, and a configured key in hybrid. Disabled engines are never called.', "AnySearch 在 free 模式下使用匿名额度，在 api 模式下使用 Key，在 hybrid 模式下使用已配置的 Key。不会调用已停用的引擎。"))
  if (PENDING_ENGINE_KEY_NAMES.length) {
    clack.log.info(t(`Stored-only key slot: ${PENDING_KEYS_LABEL} is written and masked like the rest, but stays out of API engine routing until its engine adapter ships.`, `仅保存的凭据槽位：${PENDING_KEYS_LABEL} 与其他 Key 一样保存并脱敏显示，但在引擎适配器发布前不会加入 api 引擎池。`))
  }

  clack.log.info(t('Custom API bases receive search queries and API keys. Use only trusted gateways; request paths are appended automatically.', "自定义 API 地址将收到搜索查询和 API Keys。请仅使用可信网关；请求路径会自动追加。"))

  // Only changed keys are patched; keep unrelated concurrent edits intact.
  const patch = {}

  const urlPatch = {}
  const currentBases = readEngineBaseUrls()
  for (const name of CONFIG_KEY_NAMES) {
    const status = keyStatus()[name]
    const hint = status.source === 'file'
      ? t(`current: ${status.masked}`, `当前：${status.masked}`)
      : status.source === 'env'
        ? t(`from env: ${status.masked}`, `来自环境变量：${status.masked}`)
        : t('not set', '未设置')

    // URL editing returns to this engine, so keys and URLs can be changed together.
    let action
    while (true) {
      const base = name in urlPatch ? (urlPatch[name] ?? ENGINE_BASE_URLS[name]) : currentBases[name]
      action = await clack.select({
        message: `${name}${isPendingEngineKey(name) ? ` [${status.source === 'missing' ? t('stored only, adapter pending', '仅保存，适配器尚未实现') : t('stored only — not in the api pool yet', '仅保存 — 暂未加入 api 引擎池')}]` : ''} (${hint})${KEY_NAMES.includes(name) ? ` · Base URL: ${base} (${base === ENGINE_BASE_URLS[name] ? t('default', '默认') : t('custom', '自定义')})` : ''}`,
        options: [
          { value: 'keep', label: t('Keep as-is', "保持不变") },
          { value: 'set', label: t('Set / replace key', "设置 / 更换 Key") },
          { value: 'remove', label: t('Remove key from file', "移除文件中的 Key") },
          ...(KEY_NAMES.includes(name) ? [
            { value: 'url', label: t('Set / replace Base URL', "设置 / 更换 Base URL"), hint: t('trusted API-compatible gateway', "可信的 API 兼容网关") },
            { value: 'reset-url', label: t('Restore default Base URL', "恢复默认 Base URL"), hint: ENGINE_BASE_URLS[name] },
          ] : []),
        ],
        initialValue: status.source === 'missing' ? 'set' : 'keep',
      })
      handleCancel(action, clack)
      if (action === 'reset-url') {
        urlPatch[name] = null
        continue
      }
      if (action !== 'url') break
      const value = await clack.text({
        message: t(`${name} API base URL (not the full search endpoint)`, `${name} API Base URL（不是完整搜索端点）`),
        placeholder: ENGINE_BASE_URLS[name],
        defaultValue: base,
        validate: (value) => {
          try { normalizeEngineBaseUrl(value || base) } catch (err) { return err.message }
        },
      })
      handleCancel(value, clack)
      urlPatch[name] = normalizeEngineBaseUrl(String(value || base))
      clack.log.info(t(`Search endpoint: ${engineSearchUrl(name, { [name]: urlPatch[name] })}`, `搜索端点：${engineSearchUrl(name, { [name]: urlPatch[name] })}`))
    }

    if (action === 'keep') continue
    if (action === 'remove') {
      patch[name] = undefined
      continue
    }

    const value = await clack.password({
      message: t(`${name} API key`, `${name} API Key`),
      validate: (v) => {
        if (!v?.trim()) return t('Key cannot be empty (choose Remove to clear)', "Key 不能为空（请使用移除操作清除）。")
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
    const initialValues = initial

    const selected = await clack.multiselect({
      message: t('Which API engines should search-boost use? (one is enough)', "search-boost 使用哪些 API 引擎？（一个即可）"),
      options: configured.map((name) => ({
        value: name,
        label: name,
        hint: t('key configured', '已配置 Key'),
      })),
      initialValues: initialValues.filter((name) => keysAfter[name]),
      required: false,
    })
    handleCancel(selected, clack)
    if (!Array.isArray(selected) || selected.some(name => !configured.includes(name)) || new Set(selected).size !== selected.length) throw new Error('Choose only configured engines from the displayed list; routing was not changed.')

    if (selected.length === 0) {
      clack.log.warn(t('No APIs enabled — default searches use keyless engines.', "未启用 API — 默认使用免 Key 引擎。"))
      enabledEngines = []
    } else {
      enabledEngines = /** @type {string[]} */ (selected)
      // Selecting an engine here is an explicit enable, so the write below also
      // clears any stale per-engine disable flag for the selected names.
      if (selected.length === 1) {
        clack.log.info(t(`Single-engine mode (${selected[0]}) is active by default; no layer switch is needed.`, `默认使用单引擎（${selected[0]}），无需切换层。`))
      } else if (selected.length < KEY_NAMES.length) {
        clack.log.info(t(RECOMMEND_ALL_KEYED_ENGINES, "配置更多引擎有助于扩大检索范围。"))
      }
    }
  }

  if (dryRun) {
    for (const [name, base] of Object.entries(urlPatch)) wouldWrite(`${name} Base URL → ${base ?? ENGINE_BASE_URLS[name]}`)
    wouldWrite(t(`would set API engines to: ${enabledEngines === null ? 'all configured' : (enabledEngines.join(', ') || '(none)')}`, `将 API 引擎设为：${enabledEngines === null ? '所有已配置引擎' : (enabledEngines.join(', ') || '（无）')}`))
  } else {
    writeKeysFile({ ...patch, baseUrls: urlPatch, enabledEngines })
  }
  const pendingStored = PENDING_ENGINE_KEY_NAMES.filter((name) => Boolean(keysAfter[name]))
  if (pendingStored.length) {
    clack.log.info(t(`${pendingStored.join(', ')} stored; API engine routing stays ${KEY_NAMES.join(', ')} until the adapter lands.`, `${pendingStored.join(', ')} 已保存；在适配器实现前，API 路由仍使用 ${KEY_NAMES.join(', ')}。`))
  }
  if (!dryRun) clack.log.success(t(`Saved ${tildify(keysFilePath())}`, `已保存 ${tildify(keysFilePath())}`))
}

/**
 * Engine-first credential configuration for the TUI: pick one engine, change it,
 * come back. Which keyed engines run by default is its own entry instead
 * of a question forced after every key edit. `config keys` and Setup keep the
 * sequential wizard, which guides every slot in one pass.
 * @param {import('@clack/prompts').ClackPrompter | null} clack
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function runEngineConfigTui(clack, opts = {}) {
  if (!clack) return
  const dryRun = Boolean(opts.dryRun)
  clack.log.info(t(`Keys are stored in ${tildify(keysFilePath())} (not in agent MCP configs).`, `Keys 保存在 ${tildify(keysFilePath())}，不会写入 Agent 的 MCP 配置。`))
  clack.log.info(t(`Env vars ${CONFIG_KEY_NAMES.map((name) => ENV_MAP[name]).join(' / ')} also work.`, `也可使用环境变量 ${CONFIG_KEY_NAMES.map((name) => ENV_MAP[name]).join(' / ')}。`))
  clack.log.info(t('Custom API bases receive search queries and API keys. Use only trusted gateways; request paths are appended automatically.', '自定义 API 地址将收到搜索查询和 API Keys。请仅使用可信网关；请求路径会自动追加。'))
  for (;;) {
    const action = await clack.select(engineMenu())
    if (clack.isCancel(action) || action === 'back') return
    if (action === 'routing') await keepEngineListOnCancel(() => runEngineRoutingTui(clack, { dryRun }))
    else await keepEngineListOnCancel(() => runEngineEntryTui(clack, action, { dryRun }))
  }
}

/** Esc inside a nested engine prompt steps back to the engine list; Ctrl+C still exits the TUI. */
async function keepEngineListOnCancel(work) {
  try {
    return await work()
  } catch (err) {
    if (err instanceof TuiExit) throw err
    if (!(err instanceof TuiCancelled)) throw err
  }
}

/**
 * Credential rows for the engine menu. `storedOnly` slots are stored and masked
 * like the rest but stay out of API engine routing until their adapter ships.
 * @param {{
 *   pending?: string[],
 *   status?: Record<string, { source: 'file'|'env'|'missing', masked?: string }>,
 *   routing?: ReturnType<typeof readEngineRouting>,
 *   keys?: Record<string, string|undefined>,
 * }} [options]
 * @returns {{ name: string, storedOnly: boolean, hint: string }[]}
 */
export function engineCredentialRows({ pending = PENDING_ENGINE_KEY_NAMES, status = keyStatus(), routing = readEngineRouting(), keys = readKeys() } = {}) {
  const enabled = new Set(resolveKeyedEngines(keys, routing))
  return [...new Set([...KEY_NAMES, ...pending])].map((name) => ({
    name,
    storedOnly: pending.includes(name) && !KEY_NAMES.includes(name),
    hint: engineRowHint(name, status[name] ?? { source: 'missing' }, enabled.has(name)),
  }))
}

// One place for engine presentation so a newly added keyed engine cannot show
// up as a bare id without its api/hybrid note.
const ENGINE_LABELS = { tinyfish: 'TinyFish Search', 'deepseek-search': 'DeepSeek Search', firecrawl: 'Firecrawl', keenable: 'Keenable' }
const API_ONLY_HINT_ENGINES = new Set(['tinyfish', 'deepseek-search', 'firecrawl', 'keenable'])

function engineRowHint(name, status, enabled) {
  const detail = engineCredentialDetail(name, status)
  if (!KEY_NAMES.includes(name)) return `${detail} · ${t('stored only, adapter pending', '仅保存，适配器尚未实现')}`
  const state = status.source === 'missing' ? t('no key', '未配置 Key') : enabled ? t('enabled', '已启用') : t('disabled', '已停用')
  const poolHint = API_ONLY_HINT_ENGINES.has(name) ? ` · ${t('api/hybrid · key required', 'api/hybrid · 需要 Key')}` : ''
  return `${detail} · ${state}${poolHint}`
}

/** Masked credential source only: the raw key is never rendered. */
function engineCredentialDetail(name, status) {
  if (status.source === 'file') return t(`file ${status.masked}`, `文件 ${status.masked}`)
  if (status.source === 'env') return t(`from env: ${status.masked}`, `来自环境变量：${status.masked}`)
  return name === 'anysearch' ? t('anonymous in free · no key', 'free 下匿名 · 未配置 Key') : t('not set', '未设置')
}

function engineMenu() {
  return {
    message: t('Engine configuration', '搜索引擎配置'),
    options: [
      ...engineCredentialRows().map((row) => ({ value: row.name, label: ENGINE_LABELS[row.name] ?? row.name, hint: row.hint })),
      { value: 'routing', label: t('Enable / disable engines', '引擎启用 / 停用'), hint: engineRoutingHint() },
      { value: 'back', label: t('Back', '返回') },
    ],
  }
}

function engineRoutingHint() {
  const { summary } = readKeysRouting()
  if (summary.configured === 0) return t('no keyed engine configured', '尚无已配置的引擎')
  return t(
    `${summary.enabled}/${summary.total} keyed engines enabled (${summary.enabledNames.join(', ') || 'none'})`,
    `已启用 ${summary.enabled}/${summary.total} 个引擎（${summary.enabledNames.join(', ') || '无'}）`,
  )
}

/** Changing one engine must never imply a routing decision. */
async function runEngineEntryTui(clack, name, { dryRun }) {
  if (name === 'deepseek-search') {
    clack.log.info(t('Native DeepSeek web search uses DEEPSEEK_API_KEY and a billable model turn per query variant. Enabled keys join api/hybrid. Base URL is independent of chat; /messages is appended. Configuration does not test connectivity.', 'DeepSeek 原生联网搜索使用 DEEPSEEK_API_KEY，每个查询变体调用一次可能计费的模型。启用后加入 api/hybrid。Base URL 独立于聊天配置，自动追加 /messages；配置过程不测试联网。'))
  }
  if (name === 'tinyfish') {
    clack.log.info(t('TinyFish Search requires an API key (TINYFISH_API_KEY also works). Enabled keys join api/hybrid, not the default free pool; explicit engines can override the pool. Configuration does not test connectivity.', 'TinyFish Search 需要 API Key（也可使用 TINYFISH_API_KEY）。启用后加入 api/hybrid，不加入默认 free 池；显式 engines 可覆盖池选择。配置过程不测试联网。'))
  }
  if (name === 'firecrawl') {
    clack.log.info(t('Firecrawl requires an API key (FIRECRAWL_API_KEY also works). It uses POST /v2/search with a Bearer token and bills per search. Enabled keys join api/hybrid, not the default free pool. Results carry no publication date unless the gateway enables scraping. Configuration does not test connectivity.', 'Firecrawl 需要 API Key（也可使用 FIRECRAWL_API_KEY）。使用 POST /v2/search 和 Bearer 令牌，按次计费。启用后加入 api/hybrid，不加入默认 free 池。除非网关启用抓取，结果不带发布时间。配置过程不测试联网。'))
  }
  if (name === 'keenable') {
    clack.log.info(t('Keenable requires an API key (KEENABLE_API_KEY also works). It uses POST /v1/search with an X-API-Key header and bills per search. Enabled keys join api/hybrid, not the default free pool. Configuration does not test connectivity.', 'Keenable 需要 API Key（也可使用 KEENABLE_API_KEY）。使用 POST /v1/search 和 X-API-Key 头，按次计费。启用后加入 api/hybrid，不加入默认 free 池。配置过程不测试联网。'))
  }
  const routable = KEY_NAMES.includes(name)
  for (;;) {
    const status = keyStatus()[name] ?? { source: 'missing' }
    const currentBase = readEngineBaseUrls()[name]
    const enabled = resolveKeyedEngines(readKeys(), readEngineRouting()).includes(name)
    const action = await clack.select({
      message: `${name} — ${engineCredentialDetail(name, status)}${routable && status.source !== 'missing' ? ` · ${enabled ? t('enabled', '已启用') : t('disabled', '已停用')}` : ''}${routable ? '' : ` · ${t('stored only, adapter pending', '仅保存，适配器尚未实现')}`}`,
      options: [
        {
          value: 'set',
          label: t('Set / replace API key', '设置 / 更换 API Key'),
          ...(routable ? {} : { hint: t('stored only, adapter pending', '仅保存，适配器尚未实现') }),
        },
        ...(routable ? [
          { value: 'url', label: t('Set / replace Base URL', '设置 / 更换 Base URL'), hint: currentBase },
          { value: 'reset-url', label: t('Restore default Base URL', '恢复默认 Base URL'), hint: ENGINE_BASE_URLS[name] },
        ] : []),
        // Clack 0.10 has no per-option disabled API. Do not offer a mutation
        // that cannot affect an environment-only or missing credential.
        ...(routable && status.source !== 'missing' ? [{ value: 'toggle', label: enabled ? t('Disable this API', '停用此 API') : t('Enable this API', '启用此 API') }] : []),
        ...(routable && status.source !== 'missing' ? [{ value: 'only', label: t('Use only this API', '只用这个 API'), hint: t('disable other APIs; keep their keys', '停用其他 API，保留其 Key') }] : []),
        ...(status.source === 'file' ? [{ value: 'remove', label: t('Remove key from file', '移除文件中的 Key') }] : []),
        { value: 'back', label: t('Back to engine configuration', '返回搜索引擎配置') },
      ],
    })
    if (clack.isCancel(action) || action === 'back') return

    if (action === 'only') {
      if (!routable || status.source === 'missing') throw new Error('No key')
      const snapshot = readKeysFileDocument()
      const confirmed = await clack.confirm({
        message: t(`Use only ${name}? Other APIs will be disabled, but their keys will be kept.`, `只用 ${name}？其他 API 将停用，但保留 Key。`),
        initialValue: false,
      })
      handleCancel(confirmed, clack)
      if (confirmed === true) {
        if (dryRun) clack.log.info(t(`dry-run: would use only ${name} (nothing written)`, `dry-run：将只用 ${name}（不写入配置）。`))
        else {
          if (JSON.stringify(snapshot) !== JSON.stringify(readKeysFileDocument())) throw new Error('Configuration changed; review the engine selection again.')
          writeKeysFile({ enabledEngines: [name] })
          clack.log.success(t(`Default searches now use only ${name}.`, `默认搜索现只用 ${name}。`))
        }
      }
      continue
    }

    if (action === 'toggle') {
      const names = new Set(resolveKeyedEngines(readKeys(), readEngineRouting()))
      if (names.has(name)) names.delete(name); else names.add(name)
      if (dryRun) clack.log.info(t(`dry-run: would enable APIs: ${[...names].join(', ') || '(none)'}`, `dry-run：将启用 API：${[...names].join(', ') || '（无）'}`))
      else writeKeysFile({ enabledEngines: [...names] })
      continue
    }

    if (action === 'set') {
      const value = await clack.password({
        message: t(`${name} API key`, `${name} API Key`),
        validate: (v) => {
          if (!v?.trim()) return t('Key cannot be empty (choose Remove to clear)', 'Key 不能为空（请使用移除操作清除）。')
        },
      })
      handleCancel(value, clack)
      if (dryRun) clack.log.info(t(`dry-run: would save the ${name} key to ${tildify(keysFilePath())} (nothing written)`, `dry-run：将保存 ${name} Key 到 ${tildify(keysFilePath())}（不写入配置）。`))
      else {
        writeKeysFile({ [name]: String(value).trim() })
        clack.log.success(t(`Saved the ${name} key → ${tildify(keysFilePath())}`, `已保存 ${name} Key → ${tildify(keysFilePath())}`))
        if (readKeysRouting().enabledNames.includes(name)) clack.log.info(t(`${name} is enabled for default searches.`, `${name} 已启用，默认搜索会使用它。`))
        else clack.log.info(t('Key saved, but this API is still disabled by your engine selection. Choose Enable this API or Use only this API to start using it.', 'Key 已保存，但此 API 仍受引擎选择限制而未启用。选择“启用此 API”或“只用这个 API”即可使用。'))
      }
      continue
    }

    if (action === 'url') {
      const base = currentBase ?? ENGINE_BASE_URLS[name]
      const value = await clack.text({
        message: t(`${name} API base URL (not the full search endpoint)`, `${name} API Base URL（不是完整搜索端点）`),
        placeholder: ENGINE_BASE_URLS[name],
        defaultValue: base,
        validate: (v) => {
          try { normalizeEngineBaseUrl(v || base) } catch (err) { return err.message }
        },
      })
      handleCancel(value, clack)
      const url = normalizeEngineBaseUrl(String(value || base))
      if (dryRun) clack.log.info(t(`dry-run: would set the ${name} Base URL to ${url} (nothing written)`, `dry-run：将 ${name} Base URL 设为 ${url}（不写入配置）。`))
      else {
        writeKeysFile({ baseUrls: { [name]: url } })
        clack.log.info(t(`Search endpoint: ${engineSearchUrl(name, { [name]: url })}`, `搜索端点：${engineSearchUrl(name, { [name]: url })}`))
        clack.log.success(t(`Saved the ${name} Base URL → ${tildify(keysFilePath())}`, `已保存 ${name} Base URL → ${tildify(keysFilePath())}`))
      }
      continue
    }

    if (action === 'reset-url') {
      if (dryRun) clack.log.info(t(`dry-run: would restore the default ${name} Base URL (nothing written)`, `dry-run：将恢复 ${name} 默认 Base URL（不写入配置）。`))
      else {
        writeKeysFile({ baseUrls: { [name]: null } })
        clack.log.success(t(`${name} Base URL restored to ${ENGINE_BASE_URLS[name]}`, `${name} Base URL 已恢复默认：${ENGINE_BASE_URLS[name]}`))
      }
      continue
    }

    if (action === 'remove') {
      // Also reject a stale/injected selection: an environment key is not ours.
      if (status.source !== 'file') {
        clack.log.warn(t('No file-owned key to remove; environment credentials are unchanged.', '没有可移除的文件 Key；环境变量凭据保持不变。'))
        continue
      }
      if (dryRun) clack.log.info(t(`dry-run: would remove the ${name} key from ${tildify(keysFilePath())} (nothing written)`, `dry-run：将从 ${tildify(keysFilePath())} 移除 ${name} Key（不写入配置）。`))
      else {
        writeKeysFile({ [name]: undefined })
        clack.log.success(t(`Removed the ${name} key from ${tildify(keysFilePath())}`, `已从 ${tildify(keysFilePath())} 移除 ${name} Key`))
        const hint = envKeyHint(name)
        if (hint) clack.log.info(`Hint: ${hint}`)
      }
    }
  }
}

/** Which keyed engines automatic searches may call; only a real change is written. */
async function runEngineRoutingTui(clack, { dryRun }) {
  const status = keyStatus()
  const configured = KEY_NAMES.filter((name) => status[name].source !== 'missing')
  if (configured.length === 0) {
    clack.log.warn(t('No API key configured — default searches use keyless engines. Configure one key to use APIs.', '尚无 API Key — 默认使用免 Key 引擎，配置任意一个 Key 即可使用 API。'))
    return
  }
  const current = resolveKeyedEngines(readKeys(), readEngineRouting())
  const selected = await clack.multiselect({
    message: t('Which API engines should search-boost use? (one is enough)', 'search-boost 使用哪些 API 引擎？（一个即可）'),
    // Installed Clack does not honor `disabled`: offer only eligible engines.
    options: configured.map((name) => ({
      value: name,
      label: name,
      hint: t('key configured', '已配置 Key'),
    })),
    initialValues: current,
    required: false,
  })
  handleCancel(selected, clack)
  if (!Array.isArray(selected) || selected.some(name => !configured.includes(name)) || new Set(selected).size !== selected.length) {
    throw new Error('Choose only configured engines from the displayed list; routing was not changed.')
  }
  const next = /** @type {string[]} */ (selected)
  if (next.length === current.length && current.every((name) => next.includes(name))) {
    clack.log.info(t('Engine enablement unchanged.', '引擎启用状态未改变。'))
    return
  }
  if (next.length === 0) clack.log.warn(t('No APIs enabled — default searches use keyless engines.', '未启用 API — 默认使用免 Key 引擎。'))
  else clack.log.info(t(`Enabled keyed engines: ${next.join(', ')}`, `已启用的引擎：${next.join(', ')}`))
  if (dryRun) {
    clack.log.info(t(`dry-run: would set API engines to ${next.join(', ') || '(none)'} (nothing written)`, `dry-run：将 API 引擎设为 ${next.join(', ') || '（无）'}（不写入配置）。`))
    return
  }
  writeKeysFile({ enabledEngines: next })
  clack.log.success(t(`Saved ${tildify(keysFilePath())}`, `已保存 ${tildify(keysFilePath())}`))
}

/** @returns {string[]} */
export function formatKeyStatusLines() {
  const routing = readKeysRouting()
  const lines = [t(`API keys (${CONFIG_KEY_NAMES.join(', ')})`, `API Keys（${CONFIG_KEY_NAMES.join(', ')}）`), RULE]
  for (const name of CONFIG_KEY_NAMES) {
    const st = keyStatus()[name]
    const detail = st.source === 'missing' ? t('missing', '未配置') : `${credentialSource(st.source)}  ${st.masked}`
    const inPool = routing.enabledNames.includes(name)
    const routable = KEY_NAMES.includes(name)
    const poolTag = !routable || st.source === 'missing'
      ? ''
      : inPool
        ? t('  enabled', '  已启用')
        : routing.summary.hasExplicitRouting
          ? t('  disabled', '  已停用')
          : ''
    const pendingTag = routable || st.source === 'missing' ? '' : t('  stored only (adapter pending)', '  仅保存（适配器尚未实现）')
    lines.push(`  ${name.padEnd(10)} ${detail}${poolTag}${pendingTag}`)
    if (KEY_NAMES.includes(name)) {
      const base = routing.baseUrls[name]
      lines.push(t(`    Base URL: ${base} (${base === ENGINE_BASE_URLS[name] ? t('default', '默认') : t('custom', '自定义')})`, `    Base URL：${base}（${base === ENGINE_BASE_URLS[name] ? t('default', '默认') : t('custom', '自定义')}）`))
    }
  }
  if (routing.summary.configured > 0) {
    lines.push('', t(`Keyed pool: ${routing.summary.enabled}/${routing.summary.total} enabled (${routing.summary.enabledNames.join(', ') || 'none'})`, `API 引擎池：${routing.summary.enabled}/${routing.summary.total} 已启用（${routing.summary.enabledNames.join(', ') || '无'}）`))
  }
  const pendingStored = PENDING_ENGINE_KEY_NAMES.filter((name) => keyStatus()[name].source !== 'missing')
  if (pendingStored.length) {
    lines.push(t(`Stored, not in the api pool yet: ${pendingStored.join(', ')}`, `已保存，暂未加入 api 引擎池：${pendingStored.join(', ')}`))
  }
  lines.push('', t(`File: ${tildify(keysFilePath())}`, `文件：${tildify(keysFilePath())}`))
  return lines
}

export function printKeyStatus() {
  for (const line of formatKeyStatusLines()) console.log(line)
}
