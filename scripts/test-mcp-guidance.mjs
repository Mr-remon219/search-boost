#!/usr/bin/env node
/** Check the actual stdio contract without network calls, installed skills, or real HOME. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as z from 'zod'
import { fusedSearchInput, fetchPageInput, xSearchInput } from '../adapters/mcp/schemas.mjs'

const home = mkdtempSync(join(tmpdir(), 'sb mcp guidance '))
const client = new Client({ name: 'guidance-test', version: '1.0.0' })
const env = { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: home,
  PI_CODING_AGENT_DIR: join(home, 'pi'), SEARCH_BOOST_LAYER: 'free', SEARCH_BOOST_KEYS_FILE: join(home, 'keys.json'),
  SEARCH_BOOST_LAYER_FILE: join(home, 'layer.json'), SEARCH_BOOST_XAUTH_FILE: join(home, 'xauth.json') }
for (const key of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY', 'PI_SEARCH_TAVILY_KEY', 'PI_SEARCH_BRAVE_KEY', 'PI_SEARCH_EXA_KEY', 'XAI_API_KEY']) delete env[key]
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'serve'],
  env,
  stderr: 'pipe',
})
try {
  await client.connect(transport)
  const instructions = client.getInstructions()
  assert(instructions.includes('No skill, resource read, or routing prompt is required'))
  const { tools } = await client.listTools()
  assert.equal(tools.length, 6)
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  for (const tool of tools) assert(tool.description?.length > 40)
  for (const name of ['fused_search', 'fetch_page', 'x_search', 'search_layer']) {
    for (const [field, schema] of Object.entries(byName[name].inputSchema.properties)) {
      assert(schema.description, `${name}.${field}: missing direct-call guidance`)
    }
  }
  for (const [field, schema] of Object.entries(byName.adaptive_search.inputSchema.properties)) {
    assert(schema.description, `adaptive_search.${field}: missing direct-call guidance`)
  }
  assert.ok(['tasks', 'questions', 'cursor', 'page_size'].every((key) => key in byName.adaptive_search.inputSchema.properties))
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.minItems, 1)
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.maxItems, 6)
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.items.maxLength, 400)
  assert.equal(byName.fused_search.inputSchema.properties.max_results.maximum, 10)
  assert.deepEqual(byName.fetch_page.inputSchema.required, ['url'])
  assert.equal(byName.x_search.inputSchema.properties.allowed_x_handles.maxItems, 20)
  assert.equal(byName.x_search.inputSchema.properties.excluded_x_handles.maxItems, 20)
  // These calls work without first reading a resource, invoking a prompt, or loading any skill.
  const layer = await client.callTool({ name: 'search_layer', arguments: { layer: 'show' } })
  assert(!layer.isError)
  assert.equal(layer.structuredContent.layer, 'free')
  const stats = await client.callTool({ name: 'search_stats', arguments: {} })
  assert(!stats.isError && stats.structuredContent.engines)
  console.log('ok: tool descriptions/schemas and direct read-only calls without skills or resources')

  const { resources } = await client.listResources()
  assert(resources.some((r) => r.uri === 'search-boost://policy'))
  assert(resources.some((r) => r.uri === 'search-boost://capabilities'))
  const capability = async () => JSON.parse((await client.readResource({ uri: 'search-boost://capabilities' })).contents[0].text)
  assert.equal((await capability()).defaultEnginePool, 'free')
  assert.equal((await capability()).scoreVersion, 'consensus-v2.1')
  assert.ok((await capability()).pools.free.includes('anysearch'))
  assert.ok(!(await capability()).pools.api.includes('anysearch'))
  assert.ok(byName.fused_search.inputSchema.properties.engines.items.enum.includes('anysearch'))
  assert.equal(byName.fused_search.inputSchema.properties.min_score.minimum, 0)
  const empty = await client.callTool({ name: 'fused_search', arguments: { query: 'fixture', engine_pool: 'api', ranking: 'research', engine_weights: { exa: 0 }, community: false } })
  assert(!empty.isError)
  assert.deepEqual(empty.structuredContent.enginesUsed, [])
  assert.deepEqual(empty.structuredContent.effectiveWeights, {})
  assert.equal(empty.structuredContent.communityUsed, false)
  assert.ok(empty.structuredContent.warnings.length > 0)
  writeFileSync(join(home, 'keys.json'), JSON.stringify({ tavily: 'fixture-secret-tavily' }))
  assert.ok((await capability()).availableEngines.includes('tavily'))
  assert.ok(!JSON.stringify(await capability()).includes('fixture-secret'))
  writeFileSync(join(home, 'keys.json'), JSON.stringify({ tavily: 'fixture-secret-tavily', enabledEngines: [] }))
  assert.ok(!(await capability()).availableEngines.includes('tavily'), 'Resource re-reads current routing each time')
  console.log('ok: live MCP capability resource and actual fused output metadata, without live engine calls')
  // adaptive_search is registered unconditionally and stays honest without Jev.
  const adaptive = await client.callTool({ name: 'adaptive_search', arguments: { questions: ['fixture question'] } })
  assert.equal(adaptive.isError, true)
  assert.equal(adaptive.structuredContent.stopReason, 'not_configured')
  assert.equal(adaptive.structuredContent.results.length, 0)
  assert.equal(adaptive.structuredContent.coverageComplete, false)
  assert.match(adaptive.content[0].text, /search-boost config jev/)
  assert.ok(!JSON.stringify(adaptive.structuredContent).includes('fixture-secret'), 'no credential material in the result')
  const taskCall = await client.callTool({ name: 'adaptive_search', arguments: { tasks: [{ context: 'Fixture product', targets: [{ id: 'pricing', keywords: ['pricing', 'price'], question: 'What is the price?' }] }] } })
  assert.equal(taskCall.structuredContent.stopReason, 'not_configured')
  assert.deepEqual(taskCall.structuredContent.results, [])
  const mixedCall = await client.callTool({ name: 'adaptive_search', arguments: { questions: ['x'], cursor: 'invalid' } })
  assert.equal(mixedCall.isError, true)
  let invalidRejected = false
  try {
    const invalid = await client.callTool({ name: 'adaptive_search', arguments: { questions: [] } })
    invalidRejected = Boolean(invalid.isError)
  } catch {
    invalidRejected = true
  }
  assert.ok(invalidRejected, 'an empty question list is rejected at the protocol boundary')
  const capabilityText = JSON.stringify(await capability())
  assert.ok(capabilityText.includes('adaptive'), 'capability reports Jev readiness without a key')
  assert.ok(!/adaptive_search is available/.test(capabilityText) || capabilityText.includes('"configured":false'), 'no advertising while unconfigured')
  console.log('ok: adaptive_search registers honestly without Jev credentials and never exposes keys')
  const resource = await client.readResource({ uri: 'search-boost://policy' })
  const text = resource.contents[0].text
  const examples = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  assert(examples.length >= 5)
  for (const [, json] of examples) {
    const value = JSON.parse(json)
    const schema = 'url' in value ? fetchPageInput : 'type' in value ? xSearchInput : fusedSearchInput
    z.object(schema).strict().parse(value)
  }
  const prompt = await client.getPrompt({ name: 'search_routing', arguments: { task: 'Compare two API versions' } })
  assert(prompt.messages[0].content.text.includes('Compare two API versions'))
  assert(prompt.messages[0].content.text.includes('Do not change search layers'))
  assert(prompt.messages[0].content.text.includes('Do not assume subagent tools exist'))
  console.log('ok: optional resource examples match schemas; routing prompt remains explicit planning')
} finally {
  await client.close()
  rmSync(home, { recursive: true, force: true })
}
