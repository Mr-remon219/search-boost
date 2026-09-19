#!/usr/bin/env node
/** Check the actual stdio contract without network calls, installed skills, or real HOME. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as z from 'zod'
import { fusedSearchInput, fetchPageInput, xSearchInput } from '../adapters/mcp/schemas.mjs'

const home = mkdtempSync(join(tmpdir(), 'sb mcp guidance '))
const client = new Client({ name: 'guidance-test', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'serve'],
  env: { ...process.env, HOME: home, USERPROFILE: home, SEARCH_BOOST_HOME: home,
    SEARCH_BOOST_LAYER: 'free', SEARCH_BOOST_KEYS_FILE: join(home, 'keys.json'),
    SEARCH_BOOST_LAYER_FILE: join(home, 'layer.json'), SEARCH_BOOST_XAUTH_FILE: join(home, 'xauth.json') },
  stderr: 'pipe',
})
try {
  await client.connect(transport)
  const instructions = client.getInstructions()
  assert(instructions.includes('No skill, resource read, or routing prompt is required'))
  const { tools } = await client.listTools()
  assert.equal(tools.length, 5)
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  for (const tool of tools) assert(tool.description?.length > 40)
  for (const name of ['fused_search', 'fetch_page', 'x_search', 'search_layer']) {
    for (const [field, schema] of Object.entries(byName[name].inputSchema.properties)) {
      assert(schema.description, `${name}.${field}: missing direct-call guidance`)
    }
  }
  assert.equal(byName.fused_search.inputSchema.properties.max_results.maximum, 10)
  assert.deepEqual(byName.fetch_page.inputSchema.required, ['url'])
  // These calls work without first reading a resource, invoking a prompt, or loading any skill.
  const layer = await client.callTool({ name: 'search_layer', arguments: { layer: 'show' } })
  assert(!layer.isError)
  assert.equal(layer.structuredContent.layer, 'free')
  const stats = await client.callTool({ name: 'search_stats', arguments: {} })
  assert(!stats.isError && stats.structuredContent.engines)
  console.log('ok: tool descriptions/schemas and direct read-only calls without skills or resources')

  const { resources } = await client.listResources()
  assert(resources.some((r) => r.uri === 'search-boost://policy'))
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
