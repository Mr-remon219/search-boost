#!/usr/bin/env node
/**
 * search-boost MCP server (stdio) for Cursor.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { dshRepoRoot } from './lib/dsh-lib.mjs'
import { loadMcpServerInstructionsPath } from './lib/agents/shared.mjs'
import { registerAll } from './tools/register.mjs'

const PKG_ROOT = dirname(fileURLToPath(import.meta.url))

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

function loadInstructions() {
  try {
    const path = loadMcpServerInstructionsPath()
    if (path) return readFileSync(path, 'utf8').trim()
  } catch { /* fall through */ }
  return 'search-boost MCP: fused_search, fetch_page, x_search, deep_research. Use when you need verifiable external facts — at your discretion.'
}

// Validate dsh sibling early — fail fast with clear stderr (stdio transport must not log to stdout)
try {
  dshRepoRoot()
} catch (err) {
  console.error('[search-boost-mcp]', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const server = new McpServer(
  { name: 'search-boost', version: pkgVersion() },
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
