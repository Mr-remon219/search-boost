/**
 * MCP host adapter — stdio server bootstrap. One server process serves every
 * MCP client (Cursor, Codex, Claude Code, Grok Build, Antigravity).
 */
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadMcpServerInstructionsPath } from '../../lib/agents/shared.mjs'
import { getVersion } from '../../lib/pkg.mjs'
import { registerAll } from './register.mjs'

function loadInstructions() {
  try {
    const path = loadMcpServerInstructionsPath()
    if (path) return readFileSync(path, 'utf8').trim()
  } catch { /* fall through */ }
  return 'search-boost MCP: call tools directly using their descriptions and schemas. No skill or resource read is required.'
}

/** Build a configured McpServer (no transport attached) — used by serve and tests. */
export function createMcpServer() {
  const server = new McpServer(
    { name: 'search-boost', version: getVersion() },
    {
      instructions: loadInstructions(),
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
    },
  )
  registerAll(server)
  return server
}

/** Serve over stdio until SIGINT/SIGTERM. */
export async function serveStdio() {
  const server = createMcpServer()
  const transport = new StdioServerTransport()

  async function shutdown() {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await server.connect(transport)
}
