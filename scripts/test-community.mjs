#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CommunityRegistry } from '../lib/community/registry.mjs'
import { existingXProvider } from '../lib/community/providers/x.mjs'
import { communityConfigPath, communityCapabilities, communityRegistry } from '../lib/community/config.mjs'
import { communitySearch } from '../lib/community/service.mjs'
import { COMMUNITY_SEARCH_INPUT, COMMUNITY_BACKEND_INPUT, COMMUNITY_DESCRIPTION, COMMUNITY_BACKEND_DESCRIPTION, communityZod } from '../lib/community/schemas.mjs'
import { runCommunityBackend, collectRuntimeCapabilities } from '../lib/runtime.mjs'
import { saveToolPreferences, toolState } from '../lib/tool-config.mjs'
import { registerAll } from '../adapters/mcp/register.mjs'
import piExtension from '../adapters/pi/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const snapshot = () => ({ capability: { x: { official: { available: false }, fallback: { available: true } } } })
const backend = args => runCommunityBackend(args, { snapshot })
assert.throws(() => new CommunityRegistry().register({}), /Invalid/)
assert.throws(() => new CommunityRegistry().register(existingXProvider).register(existingXProvider), /Duplicate/)
assert.throws(() => communityRegistry.get('arbitrary-package'), /Unknown/)
assert.equal(backend({ action: 'list' }).backends[0].ready, true)
assert.equal(existsSync(communityConfigPath()), false, 'list must not create configuration')
assert.throws(() => backend({ action: 'register', id: 'bad', provider: 'arbitrary-package' }), /Unknown/)
assert.equal(existsSync(communityConfigPath()), false)
assert.throws(() => backend({ action: 'register', id: 'bad', provider: 'existing-x', config: { cookie: 'SECRET' } }), /Invalid/)
backend({ action: 'register', id: 'alternate', provider: 'existing-x' })
assert.throws(() => backend({ action: 'register', id: 'alternate', provider: 'existing-x' }), /already exists/)
backend({ action: 'update', id: 'x-default', enabled: false })
assert.equal(backend({ action: 'check', id: 'x-default' }).backends[0].ready, false)
assert.equal(backend({ action: 'list' }).backends.find(row => row.id === 'alternate').enabled, true)
assert.throws(() => backend({ action: 'remove', id: 'x-default' }), /Cannot remove/)
assert.throws(() => backend({ action: 'list', enabled: true }), /do not apply/)
backend({ action: 'remove', id: 'alternate' })
assert.equal(backend({ action: 'list' }).backends.length, 5)
backend({ action: 'update', id: 'reddit-default', enabled: false })
const disabled = await communitySearch({ engines: ['x'], query: 'fixture' }, { snapshot })
assert.equal(disabled.channels[0].status, 'disabled')
backend({ action: 'update', id: 'x-default', enabled: true })

let calls = 0
const fixtureX = async (args, options) => {
  calls++
  assert.equal(options.snapshot().capability.x.fallback.available, true)
  return { via: 'fallback', cacheHit: true, items: [{ id: '1', text: 'fixture evidence', url: 'https://x.com/alice/status/1', provenance: [{ engine: 'bing', rank: 1 }] }], warnings: [] }
}
for (const args of [
  { type: 'keyword', query: 'fixture' }, { type: 'semantic', query: 'fixture' },
  { type: 'user', username: 'alice' }, { type: 'thread', post_id: '1' },
]) {
  const out = await communitySearch({ engines: ['x'], ...args }, { snapshot, xSearch: fixtureX })
  assert.equal(out.status, 'ok')
  assert.equal(out.items[0].backend, 'x-default')
  assert.equal(out.items[0].text, 'fixture evidence')
  assert.equal(out.items[0].provenance[0].engine, 'bing')
  assert.equal(out.channels[0].cache_hit, true)
}
assert.equal(calls, 4, 'one dispatch per operation')
const partial = await communitySearch({ engines: ['reddit', 'x'], query: 'fixture' }, { snapshot, xSearch: fixtureX })
assert.equal(partial.status, 'partial')
assert.equal(partial.channels[0].status, 'disabled')
assert.equal(partial.results, 1)
const beforeInvalid = calls
for (const args of [
  { engines: ['x', 'x'], query: 'fixture' }, { engines: ['x'], type: 'keyword' },
  { engines: ['x', 'reddit'], type: 'thread', post_id: '1' },
  { engines: ['x'], query: 'fixture', allowed_x_handles: ['a'], excluded_x_handles: ['b'] },
  { engines: ['x'], query: 'fixture', max_results: 31 },
  { engines: ['x'], query: 'fixture', from_date: 'not-a-date' },
]) await assert.rejects(() => communitySearch(args, { snapshot, xSearch: fixtureX }))
assert.equal(calls, beforeInvalid)
const controller = new AbortController()
controller.abort()
await assert.rejects(() => communitySearch({ engines: ['x'], query: 'fixture' }, { snapshot, xSearch: fixtureX, signal: controller.signal }), /abort/i)
const failed = await communitySearch({ engines: ['x'], query: 'fixture' }, { snapshot, xSearch: async () => { throw new Error('SECRET') } })
assert.equal(failed.status, 'failed')
assert.doesNotMatch(JSON.stringify(failed), /SECRET/)
const original = readFileSync(communityConfigPath(), 'utf8')
writeFileSync(communityConfigPath(), '{broken')
assert.throws(() => backend({ action: 'register', id: 'other', provider: 'existing-x' }), /valid JSON/)
assert.equal(readFileSync(communityConfigPath(), 'utf8'), '{broken')
assert.equal(collectRuntimeCapabilities().community.platforms.every(row => !row.ready), true)
assert.equal(communityCapabilities().error, 'Community configuration unreadable or invalid')
writeFileSync(communityConfigPath(), original)

saveToolPreferences({ x_search: false })
assert.equal(toolState('community_search').enabled, false, 'legacy explicit opt-out preserved')
saveToolPreferences({ community_search: true })
assert.equal(toolState('community_search').enabled, true)
assert.equal(toolState('x_search').enabled, false)
saveToolPreferences({ x_search: true })

// Schema projections and actual native Pi registration; no X network calls.
for (const [schema, input] of [[COMMUNITY_SEARCH_INPUT, { engines: ['x'], query: 'fixture' }], [COMMUNITY_BACKEND_INPUT, { action: 'list' }]]) {
  assert.deepEqual(communityZod(schema).parse(input), input)
}
const piTools = new Map()
piExtension({ on() {}, registerCommand() {}, registerTool: definition => piTools.set(definition.name, definition) })
assert.equal(piTools.get('community_search').description, COMMUNITY_DESCRIPTION)
assert.equal(piTools.get('community_backend').description, COMMUNITY_BACKEND_DESCRIPTION)
assert.equal(piTools.get('community_backend').annotations.readOnlyHint, false)
const piList = await piTools.get('community_backend').execute('fixture', { action: 'list' })
assert.deepEqual(piList.details, piList.structuredContent)
assert.deepEqual(JSON.parse(piList.content[0].text), piList.details)

// Real MCP protocol round trip (including schema conversion, resource and gates).
const server = new McpServer({ name: 'fixture', version: '1' })
const stop = registerAll(server)
const client = new Client({ name: 'fixture', version: '1' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
try {
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const listed = await client.listTools()
  const search = listed.tools.find(tool => tool.name === 'community_search')
  assert.equal(search.description, COMMUNITY_DESCRIPTION)
  assert.equal(listed.tools.find(tool => tool.name === 'community_backend').annotations.readOnlyHint, false)
  const result = await client.callTool({ name: 'community_backend', arguments: { action: 'list' } })
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  const unsupported = await client.callTool({ name: 'community_search', arguments: { engines: ['reddit'], query: 'fixture' } })
  assert.equal(unsupported.isError, true)
  assert.equal(unsupported.structuredContent.status, 'failed')
  const resource = await client.readResource({ uri: 'search-boost://community-capabilities' })
  const capabilities = JSON.parse(resource.contents[0].text)
  assert.equal(capabilities.platforms.find(row => row.platform === 'reddit').supported, true)
  assert.doesNotMatch(resource.contents[0].text, /SECRET|auth_token/)
  saveToolPreferences({ community_backend: false })
  const blocked = await client.callTool({ name: 'community_backend', arguments: { action: 'list' } })
  assert.equal(blocked.isError, true)
} finally { stop(); await client.close(); await server.close() }
console.log('ok: community registry/config, X delegation, partial failures, privacy, switches, Pi and real MCP contracts')
