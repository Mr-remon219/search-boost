/** Install a host router and optional, independently discoverable workflow skills. */
import { readFile, unlink, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillBundleSources, SKILL_HOST_CONTEXT, openaiYamlPath, RETIRED_SKILL_NAMES, extensionSkillRoutes, parallelHostPath } from '../agents/router.mjs'
import { renderResearchTemplate } from './search/parallel-contract.mjs'
import { buildSkillHeader, isOwnedSearchBoostSkill } from './agents/shared.mjs'
import { writeTextFile } from './json-config.mjs'

const METADATA_MARKER = '# search-boost: skill-metadata'

async function optionalText(path) {
  try { return await readFile(path, 'utf8') } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function skillBundleFiles(agentId, routerDest) {
  const root = dirname(dirname(routerDest))
  return skillBundleSources(agentId).flatMap(({ name, path }) => {
    const dest = name === 'search-boost' ? routerDest : join(root, name, 'SKILL.md')
    const files = [{ name, source: path, path: dest, metadata: false }]
    if (openaiYamlPath(agentId)) {
      files.push({ name, source: openaiYamlPath(agentId), path: join(dirname(dest), 'agents', 'openai.yaml'), metadata: true })
    }
    return files
  })
}

export async function renderSkillFile(agentId, file) {
  let body = await readFile(file.source, 'utf8')
  if (file.metadata) return `${METADATA_MARKER}\n${body.trim()}\n`
  if (!body.trimStart().startsWith('---')) body = buildSkillHeader(agentId) + body
  const prefix = ['claude', 'codex'].includes(agentId) ? 'mcp__search-boost__' : ''
  body = renderResearchTemplate(body, prefix)
  const tokens = {
    PARALLEL_HOST: body.includes('{{PARALLEL_HOST}}') ? (await readFile(parallelHostPath(agentId), 'utf8')).trim() : '',
    MCP_CONTEXT: SKILL_HOST_CONTEXT[agentId],
    EXTENSION_ROUTES: extensionSkillRoutes(agentId),
    ...Object.fromEntries(['fused_search', 'fetch_page', 'x_search', 'search_layer', 'search_stats']
      .map((tool) => [`TOOL_${tool.toUpperCase()}`, `${prefix}${tool}`])),
  }
  body = body.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!tokens[key]) throw new Error(`Unknown skill token ${key} for ${agentId}`)
    return tokens[key]
  })
  return `${body.trim()}\n`
}

function owned(content, file) {
  if (content === null) return false
  if (!file.metadata) return isOwnedSearchBoostSkill(content)
  if (content.includes(METADATA_MARKER)) return true
  // Exact legacy Codex metadata, before bundle ownership markers were introduced.
  return file.name === 'search-boost' && content.trim() === [
    'policy:', '  allow_implicit_invocation: true', 'dependencies:', '  tools:',
    '    - type: mcp', '      value: search-boost',
    '      description: Optional multi-engine web search when verification helps',
  ].join('\n')
}

export async function installSkillBundle(agentId, routerDest, { dryRun = false } = {}) {
  const files = skillBundleFiles(agentId, routerDest)
  // Preflight the whole bundle before writing any skill, including on dry-run.
  const prepared = []
  for (const file of files) {
    const current = await optionalText(file.path)
    if (current !== null && !owned(current, file)) {
      throw new Error(`Refusing to overwrite non-search-boost skill: ${file.path}`)
    }
    prepared.push({ ...file, current, content: await renderSkillFile(agentId, file) })
  }
  if (!dryRun) {
    for (const file of prepared) {
      if (file.current !== file.content) await writeTextFile(file.path, file.content)
    }
  }
  // Replace old tool-manual skills with MCP's own descriptions and reference resource.
  if (files.length) await removeOwnedSkillFiles(retiredSkillFiles(agentId, routerDest), dryRun)
  return files.map((file) => file.path)
}

function retiredSkillFiles(agentId, routerDest) {
  const root = dirname(dirname(routerDest))
  return RETIRED_SKILL_NAMES.flatMap((name) => {
    const dir = join(root, name)
    const files = [{ name, path: join(dir, 'SKILL.md'), metadata: false }]
    if (openaiYamlPath(agentId)) files.push({ name, path: join(dir, 'agents', 'openai.yaml'), metadata: true })
    return files
  })
}

export async function uninstallSkillBundle(agentId, routerDest, { dryRun = false } = {}) {
  const files = skillBundleFiles(agentId, routerDest)
  if (!files.length) return
  await removeOwnedSkillFiles([...files, ...retiredSkillFiles(agentId, routerDest)], dryRun)
}

async function removeOwnedSkillFiles(files, dryRun) {
  for (const file of files) {
    if (owned(await optionalText(file.path), file) && !dryRun) await unlink(file.path)
  }
  if (dryRun) return
  // Never recursively remove a skill directory: user references or scripts may live there.
  const dirs = new Set(files.map((file) => dirname(file.path)))
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(dir) } catch (err) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err
    }
  }
}
