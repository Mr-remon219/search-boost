import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeKeysFile, KEY_NAMES, keysFilePath } from '../lib/keys.mjs'
import { setLayer } from '../lib/layer-config.mjs'
import { engineRegistry } from '../lib/search/engines.js'
import { ENGINE_POOLS, resolveSearchRoute, defaultEnginePool } from '../lib/search/routing.js'
import { runtimeSnapshot, formatRuntimeCapabilities } from '../lib/search/capability.js'
import { runFused, domainSearch, invalidateSearchCaches } from '../lib/runtime.mjs'
import { runEngineConfigTui } from '../lib/installer/keys-wizard.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { ConsoleModel } from '../lib/console-tui.mjs'

const route = keys => resolveSearchRoute({ engines: engineRegistry(keys) })
assert.equal(route({}).enginePool, 'free', 'anonymous AnySearch does not count as a configured API')
for (const name of KEY_NAMES) {
  assert.equal(route({ [name]: 'fixture' }).enginePool, 'api')
  assert.deepEqual(route({ [name]: 'fixture' }).engineNames, [name], 'any single key works without keyless engines')
}
assert.equal(defaultEnginePool(engineRegistry({ tavily: 'fixture' }, new Set())), 'free')
for (const legacy of ['free', 'api']) {
  setLayer(legacy)
  process.env.SEARCH_BOOST_LAYER = legacy
  writeKeysFile({ tavily: 'fixture-key', enabledEngines: ['tavily'] })
  assert.equal(runtimeSnapshot().capability.defaultEnginePool, 'api', 'legacy file/env never suppress automatic API selection')
}
assert.equal(formatRuntimeCapabilities().includes('No manual layer switch is required'), true)
const real = runtimeSnapshot()
const calls = []
let fail = false
const engines = Object.fromEntries(ENGINE_POOLS.hybrid.map(name => [name, {
  available: () => real.engines[name].available(),
  availableForPool: pool => real.engines[name].availableForPool?.(pool) ?? real.engines[name].available(),
  search: async (_query, _count, opts) => {
    calls.push({ name, pool: opts.enginePool })
    if (fail) throw new Error('fixture transport failure')
    return [{ url: `https://${name.replace('-', '')}.example/alpha`, title: 'alpha source', snippet: 'alpha evidence', providerRank: 1 }]
  },
}]))
const state = { ...real, engines }
const args = { query: 'alpha', complexity: 'simple' }
const fused = opts => runFused({ ...args, ...opts }, { snapshot: () => state })
const first = await fused()
assert.equal(first.enginePool, 'api'); assert.deepEqual(first.enginesUsed, ['tavily'])
assert.deepEqual(calls, [{ name: 'tavily', pool: 'api' }])
assert.equal((await fused()).cacheHit, true)
assert.equal((await fused({ enginePool: 'hybrid' })).enginePool, 'hybrid')
assert.ok(calls.some(call => call.name === 'bing'))
assert.equal((await fused({ enginePool: 'free' })).enginePool, 'free')
assert.equal((await fused({ layer: 'api' })).enginePool, 'hybrid', 'explicit legacy alias remains supported per call')
assert.deepEqual((await fused({ engineList: ['bing'] })).enginesUsed, ['bing'])
calls.length = 0; invalidateSearchCaches(); fail = true
const failed = await fused()
assert.deepEqual(failed.enginesUsed, ['tavily']); assert.equal(failed.results.length, 0)
assert.deepEqual(calls.map(c => c.name), ['tavily'], 'provider failures never fall back to keyless engines')
fail = false; calls.length = 0
await domainSearch(engines, { query: 'alpha', includeDomains: ['tavily.example'] })
assert.deepEqual(calls.map(c => c.name), ['tavily'], 'community web-index/domain retrieval uses the same automatic default')
writeKeysFile({ enabledEngines: [] })
const disabled = runtimeSnapshot()
assert.equal(disabled.capability.defaultEnginePool, 'free')
assert.equal(disabled.engines.tavily.available(), false)
assert.equal(resolveSearchRoute({ engines: disabled.engines, enginePool: 'api' }).engineNames.length, 0, 'explicit API pool stays empty, no automatic keyless fallback')
writeKeysFile({ enabledEngines: ['tavily'] })

// Lightweight TUI: local per-engine switch, in either language, with read-only preview.
for (const language of ['en', 'zh-CN']) {
  const steps = ['tavily', 'toggle', 'back', 'back']
  const clack = {
    select: async menu => {
      const step = steps.shift(); assert.ok(menu.options.some(option => option.value === step))
      return step
    },
    isCancel: () => false,
    log: { info() {}, success() {}, warn() {} },
  }
  const before = readFileSync(keysFilePath(), 'utf8')
  await withTuiContext(() => runEngineConfigTui(clack, { dryRun: true }), { language })
  assert.equal(readFileSync(keysFilePath(), 'utf8'), before)
  assert.equal(steps.length, 0)
  steps.push('tavily', 'toggle', 'back', 'back')
  await withTuiContext(() => runEngineConfigTui(clack), { language })
  assert.equal(runtimeSnapshot().capability.defaultEnginePool, 'free')
  writeKeysFile({ enabledEngines: ['tavily'] })
}
// Full console: toggle with explicit confirmation, then refresh automatic status.
const model = new ConsoleModel({ language: 'en' })
assert.equal(model.pages.search[0].status, 'API')
assert.equal(model.pages.search[0].id, 'auto')
model.toggleEngine('tavily')
assert.equal(runtimeSnapshot().capability.defaultEnginePool, 'api', 'opening confirmation does not write')
await model.modal.options[1].run()
model.reload()
assert.equal(model.pages.search[0].status, 'FREE')
model.toggleEngine('tavily'); await model.modal.options[1].run(); model.reload()
assert.equal(model.pages.search[0].status, 'API')
assert.deepEqual(runtimeSnapshot().capability.pools.api, ['tavily'])
assert.ok(!JSON.stringify(model.pages).includes('fixture-key'))
console.log('Automatic routing: each single API, legacy file/env independence, explicit pools/aliases, no failure fallback, cache, community, both TUI switches and dry-run passed.')
