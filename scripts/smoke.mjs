/**
 * MCP protocol smoke test — spawns server, lists tools/resources/prompts.
 *
 *   node scripts/smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = join(PKG, '..', 'dsh-search-boost')

const transport = new StdioClientTransport({
  command: 'node',
  args: [join(PKG, 'cli.mjs'), 'serve'],
  cwd: PKG,
  env: {
    ...process.env,
    SEARCH_BOOST_DSH_ROOT: DSH,
    SEARCH_BOOST_LAYER: 'free',
  },
  stderr: 'pipe',
})

const client = new Client({ name: 'smoke-test', version: '0.0.1' })

try {
  await client.connect(transport)
  const init = client.getServerVersion()
  const instructions = client.getInstructions()
  const tools = await client.listTools()
  const resources = await client.listResources()
  const prompts = await client.listPrompts()

  console.log('server:', init?.name, init?.version)
  console.log('instructions:', instructions ? `${instructions.slice(0, 80)}…` : '(none)')
  console.log('tools:', tools.tools.map((t) => t.name).join(', '))
  console.log('resources:', resources.resources.map((r) => r.uri).join(', '))
  console.log('prompts:', prompts.prompts.map((p) => p.name).join(', '))

  const policy = await client.readResource({ uri: 'search-boost://policy' })
  console.log('policy bytes:', policy.contents[0]?.text?.length ?? 0)

  await client.close()
  console.log('\nSMOKE OK')
} catch (err) {
  console.error('SMOKE FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
}
