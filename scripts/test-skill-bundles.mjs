#!/usr/bin/env node
/** Router/extension installation and retired-skill migration in an isolated HOME. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
if (!process.argv.includes('--isolated')) {
  const home = mkdtempSync(join(tmpdir(), 'sb router '))
  try {
    execFileSync(process.execPath, [self, '--isolated'], {
      env: { ...process.env, HOME: home, USERPROFILE: home,
        SEARCH_BOOST_WORKSPACES_FILE: join(home, 'workspaces.json'),
        SEARCH_BOOST_CURSOR_INSTALL_STATE: join(home, 'cursor-state.json') },
      stdio: 'inherit',
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  const { AGENTS } = await import('../lib/agents/index.mjs')
  const { PATHS, grokInstallPaths, workspaceAgents } = await import('../lib/paths.mjs')
  const { installSkillBundle, uninstallSkillBundle, skillBundleFiles, renderSkillFile } = await import('../lib/agent-skills.mjs')
  const { RETIRED_SKILL_NAMES, SKILL_EXTENSIONS, extensionSkills, promptPath, STARTUP_SEARCH_POLICY } = await import('../agents/router.mjs')
  const awaitRoles = await import('../lib/search/parallel-contract.mjs')
  const home = process.env.HOME
  function snapshot(dir = home) {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, readFileSync(path, 'utf8')]]
    }))
  }
  function write(path, text) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  function retiredFiles(dest, codex = false) {
    return RETIRED_SKILL_NAMES.flatMap((name) => {
      const dir = join(dirname(dirname(dest)), name)
      return [join(dir, 'SKILL.md'), ...(codex ? [join(dir, 'agents', 'openai.yaml')] : [])]
    })
  }
  function seedRetired(dest, codex = false) {
    for (const path of retiredFiles(dest, codex)) {
      write(path, path.endsWith('.yaml') ? '# search-boost: skill-metadata\npolicy: {}\n' : '<!-- search-boost: skill -->\n# Old tool manual\n')
    }
  }
  function verifyBundle(id, dest) {
    const files = skillBundleFiles(id, dest)
    assert.equal(files.filter((f) => !f.metadata).length, 1 + extensionSkills(id).length)
    for (const file of files) {
      const body = readFileSync(file.path, 'utf8')
      assert(!body.includes('{{'), `${id}: unresolved template tokens`)
      if (file.metadata) {
        assert(body.includes('allow_implicit_invocation: true') && body.includes('value: search-boost'))
        continue
      }
      assert(body.startsWith('---\n'))
      assert(body.includes(`\nname: ${basename(dirname(file.path))}\n`))
      assert(/^description: \S/m.test(body))
      assert(body.includes('<!-- search-boost: skill -->'))
      for (const link of body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)) {
        assert(existsSync(resolve(dirname(file.path), link[1])), `${id}: broken link ${link[1]}`)
      }
      if (file.name === 'search-boost-parallel-research') {
        const { researchRole } = awaitRoles
        const prefix = ['claude', 'codex'].includes(id) ? 'mcp__search-boost__' : ''
        assert(body.includes(researchRole('searcher', prefix)))
        assert(body.includes(researchRole('summarizer', prefix)))
        assert(body.includes('## Host execution') && body.includes('## Shared workflow'))
        assert(body.includes('disclose serial') || body.includes('labeled serial'))
        assert(!/^allowed-tools:|^context: fork|^agent:/m.test(body), 'skill must not bypass orchestration/capability checks')
      }
      if (file.name === 'search-boost') {
        assert(!body.includes('```json') && !body.includes('allowed-tools:'))
        assert(body.includes('call MCP tools directly'))
        for (const name of RETIRED_SKILL_NAMES) assert(!body.includes(`../${name}/SKILL.md`))
        for (const entry of extensionSkills(id)) assert(body.includes(`../${entry.name}/SKILL.md`))
      }
    }
    return files
  }

  const hook = readFileSync(STARTUP_SEARCH_POLICY, 'utf8')
  assert(hook.includes('proactively') && hook.includes('user forbids browsing'))
  assert(!hook.includes('```') && !hook.includes('complexity'))
  const originalExtensions = [...SKILL_EXTENSIONS]
  assert.deepEqual(SKILL_EXTENSIONS.map((e) => e.name), ['search-boost-parallel-research'])
  for (const id of ['claude', 'codex', 'cursor', 'cursor-cli', 'grok', 'antigravity']) {
    const inject = readFileSync(promptPath(id), 'utf8')
    assert(inject.trim().split(/\s+/).length <= 80)
    assert(!/^##|^\||^[-*] |```/m.test(inject))
    assert(inject.includes('skill') && inject.includes('MCP'))
    seedRetired(PATHS[id].skill, id === 'codex')
    const opts = { skipGrokPlugin: true, replaceNative: false }
    const before = snapshot()
    const planned = await AGENTS[id].install({ ...opts, dryRun: true })
    assert.deepEqual(snapshot(), before)
    const files = await AGENTS[id].install(opts)
    const bundle = verifyBundle(id, PATHS[id].skill)
    for (const file of bundle) assert(files.includes(file.path) && planned.includes(file.path))
    assert(retiredFiles(PATHS[id].skill, id === 'codex').every((path) => !existsSync(path)))
    const installed = snapshot()
    await AGENTS[id].install(opts)
    assert.deepEqual(snapshot(), installed)
    await AGENTS[id].uninstall({ ...opts, dryRun: true })
    assert.deepEqual(snapshot(), installed)
    const note = join(dirname(PATHS[id].skill), 'user-notes.md')
    write(note, 'keep me')
    await AGENTS[id].uninstall(opts)
    for (const file of bundle) assert(!existsSync(file.path), `${id}: orphan ${file.path}`)
    assert.equal(readFileSync(note, 'utf8'), 'keep me')
    console.log(`ok: ${id} router retained, retired skills migrated, idempotence and cleanup`)
  }
  const cursorSkill = await renderSkillFile('cursor', skillBundleFiles('cursor', PATHS.cursor.skill).find((f) => f.name === 'search-boost-parallel-research'))
  const cliSkill = await renderSkillFile('cursor-cli', skillBundleFiles('cursor-cli', PATHS['cursor-cli'].skill).find((f) => f.name === 'search-boost-parallel-research'))
  assert.equal(cursorSkill.split('## Host execution')[1], cliSkill.split('## Host execution')[1], 'shared Cursor directory must not flip workflow semantics by installer order')
  assert.equal(skillBundleFiles('pi', join(home, 'pi', 'SKILL.md')).length, 0)
  assert.equal(skillBundleFiles('dsh', join(home, 'dsh', 'SKILL.md')).length, 0)

  const project = join(home, 'project')
  mkdirSync(project)
  const oldCwd = process.cwd()
  try {
    process.chdir(project)
    const paths = grokInstallPaths('project')
    seedRetired(paths.skill)
    // No config/router remains: retired skills alone must still identify the scope.
    await AGENTS.grok.uninstall({ scope: 'project', skipGrokPlugin: true })
    assert(retiredFiles(paths.skill).every((path) => !existsSync(path)))
    await AGENTS.grok.install({ scope: 'project', skipGrokPlugin: true })
    verifyBundle('grok', paths.skill)
    await AGENTS.grok.uninstall({ scope: 'project', skipGrokPlugin: true })
  } finally { process.chdir(oldCwd) }
  const ws = workspaceAgents(project)
  seedRetired(ws.skill)
  await AGENTS.antigravity.install({ workspace: project, replaceNative: false })
  const workspaceFiles = verifyBundle('antigravity', ws.skill)
  assert(retiredFiles(ws.skill).every((path) => !existsSync(path)))
  await AGENTS.antigravity.uninstall({ workspace: project })
  assert(workspaceFiles.every((f) => !existsSync(f.path)))
  console.log('ok: project scopes and orphaned retired-skill cleanup')

  const root = join(home, 'migration', 'skills', 'search-boost', 'SKILL.md')
  write(root, '---\nname: search-boost\ndescription: legacy\n---\n\n# search-boost MCP @ Codex\n')
  const legacyYaml = 'policy:\n  allow_implicit_invocation: true\ndependencies:\n  tools:\n    - type: mcp\n      value: search-boost\n      description: Optional multi-engine web search when verification helps\n'
  write(join(dirname(root), 'agents', 'openai.yaml'), legacyYaml)
  seedRetired(root, true)
  const foreign = join(dirname(dirname(root)), 'search-boost-fetch', 'SKILL.md')
  const custom = '# Custom skill\nUses mcp__search-boost__fetch_page; SEARCH_BOOST is just prose.\n'
  write(foreign, custom)
  const note = join(dirname(dirname(root)), 'search-boost-search', 'user-notes.md')
  write(note, 'preserve this reference')
  const foreignMeta = join(dirname(foreign), 'agents', 'openai.yaml')
  write(foreignMeta, 'policy:\n  allow_implicit_invocation: false\n')
  await installSkillBundle('codex', root)
  verifyBundle('codex', root)
  assert.equal(readFileSync(foreign, 'utf8'), custom)
  assert.equal(readFileSync(note, 'utf8'), 'preserve this reference')
  await uninstallSkillBundle('codex', root)
  assert.equal(readFileSync(foreignMeta, 'utf8'), 'policy:\n  allow_implicit_invocation: false\n')
  assert.equal(readFileSync(foreign, 'utf8'), custom)
  console.log('ok: legacy metadata upgrade and foreign retired-name files preserved')

  // Prove another host-specific extension remains independent of the shipped workflow.
  const name = 'search-boost-example-workflow'
  const source = join(home, 'extension-source.md')
  write(source, `---\nname: ${name}\ndescription: Test-only workflow\n---\n\n<!-- search-boost: skill -->\n{{MCP_CONTEXT}}\nUse {{TOOL_FUSED_SEARCH}} when needed.\n`)
  SKILL_EXTENSIONS.push({ name, description: 'Test-only host-specific workflow.', path: source, agents: ['claude'] })
  try {
    assert.equal(extensionSkills('codex').length, 1)
    await installSkillBundle('claude', root)
    const files = verifyBundle('claude', root)
    assert.equal(files.length, 3)
    const ext = files.find((f) => f.name === name)
    assert(readFileSync(ext.path, 'utf8').includes('mcp__search-boost__fused_search'))
    write(ext.path, custom)
    const before = snapshot()
    await assert.rejects(installSkillBundle('claude', root), /Refusing to overwrite/)
    assert.deepEqual(snapshot(), before)
    await uninstallSkillBundle('claude', root)
    assert.equal(readFileSync(ext.path, 'utf8'), custom)
    SKILL_EXTENSIONS.push({ name, description: 'duplicate', path: source })
    assert.throws(() => extensionSkills('claude'), /Invalid or duplicate/)
    SKILL_EXTENSIONS.pop()
  } finally { SKILL_EXTENSIONS.splice(0, SKILL_EXTENSIONS.length, ...originalExtensions) }
  console.log('ok: extension registry controls host filtering, installation and router links')

  for (const [id, dest] of [
    ['grok', fileURLToPath(new URL('../grok-plugin/skills/search-boost/SKILL.md', import.meta.url))],
    ['antigravity', fileURLToPath(new URL('../agents/antigravity/plugin/skills/search-boost/SKILL.md', import.meta.url))],
  ]) {
    const files = verifyBundle(id, dest)
    for (const file of files) assert.equal(readFileSync(file.path, 'utf8'), await renderSkillFile(id, file))
    assert(retiredFiles(dest).every((path) => !existsSync(path)))
  }
  const pluginConfig = JSON.parse(readFileSync(new URL('../agents/antigravity/plugin/mcp_config.json', import.meta.url), 'utf8'))
  assert.deepEqual(pluginConfig.mcpServers['search-boost'], { command: 'npx', args: ['-y', 'search-boost', 'serve'] }, 'shipped Antigravity plugin must be portable and omit type')
  console.log('ok: plugin bundles contain the router, not retired tool manuals; launch configuration is portable')
  console.log('All router/extension tests passed.')
}
