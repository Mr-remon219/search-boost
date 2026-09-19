#!/usr/bin/env node
/**
 * Sync agents/antigravity/plugin/ from source templates (single source of truth).
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANTIGRAVITY_RULE_DESCRIPTION } from '../lib/agents/shared.mjs'
import { pluginMcpEntry } from '../lib/mcp-entry.mjs'
import { STARTUP_SEARCH_POLICY } from '../agents/router.mjs'
import { installSkillBundle } from '../lib/agent-skills.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGY = join(ROOT, 'agents', 'antigravity')
const PLUGIN = join(AGY, 'plugin')

async function writeSkill() {
  await installSkillBundle('antigravity', join(PLUGIN, 'skills', 'search-boost', 'SKILL.md'))
}

async function writeRule() {
  const body = await readFile(join(AGY, 'rule.md'), 'utf8')
  const header = `---\ntrigger: always_on\ndescription: ${ANTIGRAVITY_RULE_DESCRIPTION}\n---\n\n`
  const dest = join(PLUGIN, 'rules', 'search-boost.md')
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, `${header}${body.trim()}\n`, 'utf8')
}

async function writeMcpConfig() {
  // Shipped plugins must not embed the build machine's Node/repository paths.
  // Antigravity rejects the stdio `type` field; local installs still use antigravityMcpEntry().
  const { type: _type, ...entry } = pluginMcpEntry()
  const config = { mcpServers: { 'search-boost': entry } }
  await writeFile(join(PLUGIN, 'mcp_config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

async function writePluginJson() {
  const manifest = {
    $schema: 'https://antigravity.google/schemas/v1/plugin.json',
    name: 'search-boost',
    description: 'Multi-engine web search MCP — optional fused search when you want citations or corroboration.',
  }
  await writeFile(join(PLUGIN, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function writeHooks() {
  const hooksDir = join(PLUGIN, 'hooks')
  await mkdir(hooksDir, { recursive: true })
  await copyFile(join(AGY, 'hooks', 'pre-invocation.mjs'), join(hooksDir, 'pre-invocation.mjs'))
  await copyFile(STARTUP_SEARCH_POLICY, join(hooksDir, 'search-boost-inject.md'))
  const hooks = {
    'search-boost-reminder': {
      enabled: true,
      PreInvocation: [
        {
          type: 'command',
          command: 'node ./hooks/pre-invocation.mjs',
          timeout: 5,
        },
      ],
    },
  }
  await writeFile(join(PLUGIN, 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, 'utf8')
}

async function main() {
  await mkdir(PLUGIN, { recursive: true })
  await writePluginJson()
  await writeMcpConfig()
  await writeSkill()
  await writeRule()
  await writeHooks()
  console.log('Built agents/antigravity/plugin/')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
