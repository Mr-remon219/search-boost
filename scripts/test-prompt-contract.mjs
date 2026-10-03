#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FUSED_DESCRIPTION } from '../lib/search/routing.js'
import { FETCH_DESCRIPTION, X_DESCRIPTION } from '../lib/search/tool-descriptions.js'
import { ADAPTIVE_DESCRIPTION } from '../lib/search/screening/describe.js'
import { ADAPTIVE_INPUT_SCHEMA, normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { adaptiveCandidateLimit } from '../lib/search/snapshot-capacity.js'
import { formatRuntimeCapabilities, collectRuntimeCapabilities } from '../lib/search/capability.js'
import { saveJevConfig } from '../lib/jev-config.mjs'
import { saveToolPreferences } from '../lib/tool-config.mjs'
import { MCP_POLICY_TEXT } from '../adapters/mcp/policy.mjs'
import piExtension from '../adapters/pi/index.js'
import { apply as dshExtension } from '../adapters/dsh/index.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const unconfigured = collectRuntimeCapabilities()
assert.equal(unconfigured.adaptive.configured, false)
assert.equal(unconfigured.tools.find((tool) => tool.name === 'fused_search').enabled, true)
assert.equal(unconfigured.tools.find((tool) => tool.name === 'adaptive_search').enabled, false)
assert.match(formatRuntimeCapabilities(unconfigured), /Jev is not configured/)
assert.match(formatRuntimeCapabilities(unconfigured), /Use enabled fused_search normally/)
assert.match(formatRuntimeCapabilities(unconfigured), /not a prerequisite for research/)
saveJevConfig({ apiKey: 'prompt-contract-secret' })
const capabilities = collectRuntimeCapabilities()
const live = formatRuntimeCapabilities(capabilities)
assert.match(live, /adaptive_search is available/)
assert.doesNotMatch(live, /prompt-contract-secret/)
assert.doesNotMatch(live, /questions|value levels|value 3\/4\/5|max_results|32 candidates|160 candidates|request-count/,
  'dynamic status must not inject a second tool manual')
assert.match(live, /configuration-based|Configuration readiness/)
assert.equal(capabilities.adaptive.configured, true)
saveToolPreferences({ adaptive_search: false })
assert.doesNotMatch(formatRuntimeCapabilities(), /adaptive_search is available/)
assert.match(formatRuntimeCapabilities(), /disabled by tool settings; do not call or enable it automatically/)
assert.doesNotMatch(formatRuntimeCapabilities(), /Jev is not configured/, 'configured-but-disabled is not missing configuration')
saveToolPreferences({ adaptive_search: true })
console.log('ok: live capabilities own readiness/privacy and switches, not the screening protocol')

// Both native hosts actually register the shared descriptions; no tool calls or child launches.
const piTools = new Map(), dshTools = new Map(), events = new Map(), sections = []
piExtension({ registerTool: (tool) => piTools.set(tool.name, tool), registerCommand() {},
  on: (name, handler) => events.set(name, handler) })
dshExtension({ tools: { register: (tool) => dshTools.set(tool.name, tool) },
  web: { registerSearchProvider() {}, registerFetchProvider() {} },
  systemPrompt: { section: (section) => sections.push(section) }, get: () => ({ register() {} }) })
for (const [name, description] of Object.entries({ fused_search: FUSED_DESCRIPTION,
  fetch_page: FETCH_DESCRIPTION, x_search: X_DESCRIPTION, adaptive_search: ADAPTIVE_DESCRIPTION })) {
  assert.equal(piTools.get(name).description, description)
  assert.equal(dshTools.get(name).description, description)
}
assert.match(piTools.get('fused_search').promptSnippet, /most public-web research; no Jev required/)
assert.match(piTools.get('adaptive_search').promptSnippet, /Higher-quality.*medium-to-high difficulty or uncertain.*configured Jev/)
const injected = await events.get('before_agent_start')({ systemPrompt: 'host policy' })
assert.equal((injected.systemPrompt.match(/<search_balance>/g) ?? []).length, 1)
assert.equal((injected.systemPrompt.match(/<search_capabilities>/g) ?? []).length, 1)
const reinjected = await events.get('before_agent_start')({ systemPrompt: injected.systemPrompt })
assert.equal((reinjected.systemPrompt.match(/<search_balance>/g) ?? []).length, 1)
assert.equal((reinjected.systemPrompt.match(/<search_capabilities>/g) ?? []).length, 1)
const policy = sections.find((section) => section.name === 'search:policy').text
assert.doesNotMatch(policy.split('## Shared workflow')[0], /questions|constraints|safety \/|至多 32|max_results|h1:/,
  'DSH permanent policy must not duplicate adaptive field or batch details')
assert.equal((policy.match(/## Shared workflow/g) ?? []).length, 1)
console.log('ok: native registrations and lifecycle injection preserve one policy/status/workflow')

// Reference details must describe real capacities rather than the old fixed ceiling.
for (const target of [10, 50]) assert.ok(MCP_POLICY_TEXT.includes(String(adaptiveCandidateLimit(target))))
assert.doesNotMatch(MCP_POLICY_TEXT, /snapshot of at most 32 candidates/)
assert.match(MCP_POLICY_TEXT, /historical/)
assert.match(MCP_POLICY_TEXT, /npm/)
assert.match(FUSED_DESCRIPTION, /vast majority.*research tasks.*difficult investigations/, 'fused is broadly capable, not a low-difficulty fallback')
assert.match(FUSED_DESCRIPTION, /does not require Jev/)
assert.match(FUSED_DESCRIPTION, /do not delay research or require Jev setup/)
assert.match(FUSED_DESCRIPTION, /When both tools are available/)
assert.match(FUSED_DESCRIPTION, /Prefer adaptive_search for higher-quality/)
assert.match(ADAPTIVE_DESCRIPTION, /higher-quality evidence selection on medium-to-high difficulty or uncertain/)
assert.match(ADAPTIVE_DESCRIPTION, /When enabled with configured Jev, prefer it over fused_search/)
assert.match(ADAPTIVE_DESCRIPTION, /no preliminary fused_search is required/)
assert.match(ADAPTIVE_DESCRIPTION, /direct retrieval is sufficient/)
assert.match(ADAPTIVE_DESCRIPTION, /configured alone is not a reason to use Adaptive for every search/)
assert.match(MCP_POLICY_TEXT, /routing heuristics.*not a measured entropy score/)
assert.match(ADAPTIVE_DESCRIPTION, /quantity|数量/)
assert.match(ADAPTIVE_DESCRIPTION, /whole|Every declared candidate/)
assert.match(ADAPTIVE_DESCRIPTION, /no self-imposed cumulative/)
assert.match(FETCH_DESCRIPTION, /focus miss/)
assert.match(X_DESCRIPTION, /incomplete/)
for (const [name, field] of Object.entries(ADAPTIVE_INPUT_SCHEMA.properties)) {
  assert.ok(field.description, `${name} needs direct-call field guidance`)
}
assert.equal(normalizeAdaptiveInput({ questions: ['混合 English 问题'], intent: '查证' }).question, '混合 English 问题')
assert.equal(normalizeAdaptiveInput({ questions: ['q'], intent: 'i' }).community, undefined)
assert.equal(normalizeAdaptiveInput({ questions: ['q'], intent: 'i', community: false }).community, false)
assert.throws(() => normalizeAdaptiveInput({ questions: ['q'], intent: 'i', constraints: ['c'] }), /adaptive_constraints_removed/)
assert.throws(() => normalizeAdaptiveInput({ saved_result_id: '00000000-0000-0000-0000-000000000000', max_results: 5 }), /page_size only/)
console.log('ok: narrower descriptions retain evidence limits; field validation and read modes stay unchanged')

for (const path of ['agents/shared/startup-search.md', 'agents/pi/inject.md']) {
  assert.doesNotMatch(read(path), /max_results|questions|value levels/)
  assert.match(read(path), /untrusted/)
  assert.match(read(path), /permissions|permission/)
}
assert.match(read('agents/shared/research/searcher.md'), /parent/)
assert.match(read('agents/shared/research/summarizer.md'), /Do not search, use tools/)
assert.match(read('agents/shared/research/workflow.md'), /Independent\?|independent/)
console.log('ok: policy and child surfaces keep verification, permission and role boundaries')
