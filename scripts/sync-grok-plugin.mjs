#!/usr/bin/env node
/**
 * Sync grok-plugin/ from agents/grok sources (avoid drift).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonMcpEntry } from '../lib/mcp-entry.mjs'

/** Shipped bundles pin the keyless layer; SEARCH_BOOST_LAYER overrides at runtime. */
const DIST_LAYER = 'free'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'grok-plugin')
const SKILL_SRC = join(ROOT, 'agents', 'grok', 'skill.md')
const SKILL_DEST = join(PLUGIN, 'skills', 'search-boost', 'SKILL.md')
const MCP_DEST = join(PLUGIN, '.mcp.json')

mkdirSync(dirname(SKILL_DEST), { recursive: true })
copyFileSync(SKILL_SRC, SKILL_DEST)

const mcp = {
  mcpServers: {
    'search-boost': {
      ...jsonMcpEntry(),
      env: { SEARCH_BOOST_LAYER: DIST_LAYER },
    },
  },
}
writeFileSync(MCP_DEST, `${JSON.stringify(mcp, null, 2)}\n`)

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.1.0'
const pluginJsonPath = join(PLUGIN, 'plugin.json')
const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf8'))
pluginJson.version = version
writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`)

console.log('Synced grok-plugin/')
console.log(`  ${SKILL_DEST}`)
console.log(`  ${MCP_DEST}`)
