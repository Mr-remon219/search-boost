#!/usr/bin/env node
/** Check the actual stdio contract without network calls, installed skills, or real HOME. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.equal(tools.length, 5)
  assert.ok(!tools.some((tool) => tool.name === 'adaptive_search'))
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  for (const tool of tools) assert(tool.description?.length > 40)
  for (const name of ['fused_search', 'fetch_page', 'x_search', 'search_layer']) {
    for (const [field, schema] of Object.entries(byName[name].inputSchema.properties)) {
      assert(schema.description, `${name}.${field}: missing direct-call guidance`)
    }
  }
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
  // A missing Jev configuration locks the entry; stale calls also fail.
  const adaptive = await client.callTool({ name: 'adaptive_search', arguments: { questions: ['fixture question'] } })
  assert.equal(adaptive.isError, true)
  mkdirSync(join(home, 'config'), { recursive: true })
  writeFileSync(join(home, 'config', 'keys.json'), JSON.stringify({ jev: { apiKey: 'fixture-jev' } }))
  await new Promise((resolve) => setTimeout(resolve, 700))
  byName.adaptive_search = (await client.listTools()).tools.find((tool) => tool.name === 'adaptive_search')
  assert.ok(byName.adaptive_search, 'Jev configuration hot-enables the default tool')
  for (const [field, schema] of Object.entries(byName.adaptive_search.inputSchema.properties)) {
    assert(schema.description, `adaptive_search.${field}: missing direct-call guidance`)
  }
  assert.ok(['tasks', 'questions', 'cursor', 'page_size'].every((key) => key in byName.adaptive_search.inputSchema.properties))
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.minItems, 1)
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.maxItems, 6)
  assert.equal(byName.adaptive_search.inputSchema.properties.questions.items.maxLength, 400)
  const mixedCall = await client.callTool({ name: 'adaptive_search', arguments: { questions: ['x'], cursor: 'invalid' } })
  assert.equal(mixedCall.isError, true)
  writeFileSync(join(home, 'config', 'tools.json'), JSON.stringify({ tools: { search_stats: false, adaptive_search: false } }))
  // No waiting: execution guard closes the polling window.
  assert.equal((await client.callTool({ name: 'search_stats', arguments: {} })).isError, true)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(!(await client.listTools()).tools.some((tool) => ['search_stats', 'adaptive_search'].includes(tool.name)))
  writeFileSync(join(home, 'config', 'tools.json'), JSON.stringify({ tools: { search_stats: true } }))
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'search_stats'))
  assert.ok(!(JSON.stringify(await capability())).includes('fixture-jev'))
  rmSync(join(home, 'config', 'keys.json'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'adaptive_search'))
  console.log('ok: MCP tool switches and Jev lock refresh without restarting the server')
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
