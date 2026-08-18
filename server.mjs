#!/usr/bin/env node
/**
 * search-boost MCP server (stdio) for Cursor.
 */
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadMcpServerInstructionsPath } from './lib/agents/shared.mjs'
import { getVersion } from './lib/pkg.mjs'
import { registerAll } from './tools/register.mjs'

function loadInstructions() {
  try {
    const path = loadMcpServerInstructionsPath()
    if (path) return readFileSync(path, 'utf8').trim()
  } catch { /* fall through */ }
  return 'search-boost MCP: fused_search, fetch_page, x_search, deep_research. Use when you need verifiable external facts — at your discretion.'
}

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
