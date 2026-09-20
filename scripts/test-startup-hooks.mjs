#!/usr/bin/env node
/** Real installer and hook subprocesses, isolated from the user's HOME. No network. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
if (!process.argv.includes('--isolated')) {
  const home = mkdtempSync(join(tmpdir(), 'sb startup hooks '))
  try {
    execFileSync(process.execPath, [self, '--isolated'], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        SEARCH_BOOST_WORKSPACES_FILE: join(home, 'workspaces.json'),
        SEARCH_BOOST_CURSOR_INSTALL_STATE: join(home, 'cursor-state.json'),
      },
      stdio: 'inherit',
    })
  } finally { rmSync(home, { recursive: true, force: true }) }
} else {
  const { AGENTS } = await import('../lib/agents/index.mjs')
  const { PATHS, workspaceAgents } = await import('../lib/paths.mjs')
  const { installStartupHook, uninstallStartupHook, STARTUP_HOOK_KEY } = await import('../lib/startup-hooks.mjs')
  const { buildSessionStartCommand } = await import('../lib/hooks-config.mjs')
  const home = process.env.HOME
  const cwd = join(home, 'unrelated working directory')
  mkdirSync(cwd)
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
  function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
  function runHook(path, input = {}) {
    return JSON.parse(execFileSync(process.execPath, [path], {
      cwd, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input), timeout: 5000,
    }))
  }
  function snapshot(dir = home) {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, readFileSync(path, 'utf8')]]
    }))
  }

  for (const id of ['claude', 'codex']) {
    const paths = PATHS[id]
    const foreign = { type: 'command', command: 'echo user-hook', timeout: 12 }
    const original = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign] }], Stop: [] }, custom: true }
    if (id === 'claude') original.disableAllHooks = true // Never bypass a user's hook opt-out.
    writeJson(paths.hooks, original)
    const before = snapshot()
    const opts = { autoAllow: false, replaceNative: false }
    const dryFiles = await AGENTS[id].install({ ...opts, dryRun: true })
    assert(dryFiles.includes(paths.hookScript) && dryFiles.includes(paths.hookInject))
    assert.deepEqual(snapshot(), before, `${id}: dry install writes nothing`)
    const files = await AGENTS[id].install(opts)
    assert(files.includes(paths.hooks))
    const config = readJson(paths.hooks)
    assert.deepEqual(config.hooks.SessionStart[0], original.hooks.SessionStart[0])
    assert.equal(config.disableAllHooks, original.disableAllHooks)
    assert.equal(config.hooks.SessionStart.length, 2)
    const command = config.hooks.SessionStart[1].hooks[0].command
    // Execute the actual registered command: quoting works even with spaces in HOME.
    const output = JSON.parse(execFileSync(command, { shell: true, cwd, encoding: 'utf8', input: '{}', timeout: 5000 }))
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart')
    assert(output.hookSpecificOutput.additionalContext.includes('proactively'))
    assert(output.hookSpecificOutput.additionalContext.includes('user forbids browsing'))
    assert(output.hookSpecificOutput.additionalContext.includes('workflow extensions'))
    assert(!output.hookSpecificOutput.additionalContext.includes('complexity'))
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      assert.deepEqual(runHook(paths.hookScript, { source }), output)
    }
    const installed = snapshot()
    await AGENTS[id].install(opts)
    assert.deepEqual(snapshot(), installed, `${id}: reinstall is idempotent`)
    await AGENTS[id].uninstall({ dryRun: true })
    assert.deepEqual(snapshot(), installed, `${id}: dry uninstall writes nothing`)
    // Mixed groups: remove only our handler, not neighboring user hooks or matchers.
    const mixed = readJson(paths.hooks)
    mixed.hooks.SessionStart[1].hooks.push(foreign)
    writeJson(paths.hooks, mixed)
    writeFileSync(paths.hookInject, '')
    assert.deepEqual(runHook(paths.hookScript), {})
    rmSync(paths.hookInject)
    assert.deepEqual(runHook(paths.hookScript, 'invalid JSON'), {})
    await AGENTS[id].uninstall({})
    const after = readJson(paths.hooks)
    assert.equal(after.custom, true)
    assert.equal(after.hooks.SessionStart.length, 2)
    assert.deepEqual(after.hooks.SessionStart[1].hooks, [foreign])
    assert(!existsSync(paths.hookScript))
    assert(!existsSync(paths.hookInject))
    await AGENTS[id].uninstall({})
    assert.deepEqual(readJson(paths.hooks), after)
    console.log(`ok: ${id} startup hook install/run/reinstall/dry-run/uninstall`)
  }

  // Cursor already has sessionStart: inject the proactive policy exactly once when merging targets.
  await AGENTS.cursor.install({ mergeCursorCli: true })
  const cursor = PATHS.cursor
  const cursorOutput = runHook(cursor.hookScript)
  assert.equal(cursorOutput.continue, true)
  assert.equal(cursorOutput.additional_context.split('search-boost: startup-policy').length - 1, 1)
  assert(cursorOutput.additional_context.includes('proactively'))
  await AGENTS.cursor.install({ mergeCursorCli: true })
  assert.equal(readJson(cursor.hooks).hooks.sessionStart.length, 1)
  await AGENTS.cursor.uninstall({})
  console.log('ok: cursor merged startup policy without duplicate hooks')

  const global = PATHS.antigravity
  const workspace = join(home, 'workspace with spaces')
  const ws = workspaceAgents(workspace)
  const foreignAgy = { 'user-hook': { PreInvocation: [{ type: 'command', command: 'echo user' }] } }
  writeJson(global.hooks, foreignAgy)
  writeJson(ws.hooks, foreignAgy)
  const beforeAgy = snapshot()
  const agyFiles = await AGENTS.antigravity.install({ workspace, dryRun: true })
  assert(agyFiles.includes(global.hookInject) && agyFiles.includes(ws.hookInject))
  assert.deepEqual(snapshot(), beforeAgy)
  await AGENTS.antigravity.install({ workspace })
  const first = runHook(global.hookScript, { invocationNum: 0 })
  assert.equal(first.injectSteps.length, 1)
  assert(first.injectSteps[0].ephemeralMessage.includes('proactively'))
  assert.deepEqual(runHook(ws.hookScript, { invocationNum: 0 }), { injectSteps: [] })
  for (const input of [{ invocationNum: 1 }, { invocationNum: 2 }, { invocationNum: 100 }, {}, 'invalid', null]) {
    assert.deepEqual(runHook(global.hookScript, input), { injectSteps: [] })
  }
  const disabled = readJson(global.hooks)
  disabled[STARTUP_HOOK_KEY].enabled = false
  writeJson(global.hooks, disabled)
  await AGENTS.antigravity.install({ workspace })
  assert.equal(readJson(global.hooks)[STARTUP_HOOK_KEY].enabled, false)
  assert.equal(runHook(ws.hookScript, { invocationNum: 0 }).injectSteps.length, 1)
  const agyInstalled = snapshot()
  await AGENTS.antigravity.uninstall({ workspace, dryRun: true })
  assert.deepEqual(snapshot(), agyInstalled)
  await AGENTS.antigravity.uninstall({ workspace })
  for (const paths of [global, ws]) {
    assert.deepEqual(readJson(paths.hooks), foreignAgy)
    assert(!existsSync(paths.hookScript) && !existsSync(paths.hookInject))
  }
  console.log('ok: antigravity global/workspace first-call injection, deduplication and cleanup')

  const fixture = join(home, 'helper fixtures')
  mkdirSync(fixture)
  const paths = { hooks: join(fixture, 'hooks.json'), hookScript: join(fixture, 'search-boost-session.mjs'), hookInject: join(fixture, 'search-boost-inject.md') }
  writeFileSync(paths.hooks, '{broken')
  await assert.rejects(installStartupHook(paths))
  await assert.rejects(uninstallStartupHook(paths))
  assert.equal(readFileSync(paths.hooks, 'utf8'), '{broken')
  assert(!existsSync(paths.hookScript))
  for (const malformed of [[], null, { hooks: [] }, { hooks: { SessionStart: {} } }]) {
    writeJson(paths.hooks, malformed)
    await assert.rejects(installStartupHook(paths))
    assert.deepEqual(readJson(paths.hooks), malformed)
  }
  writeJson(paths.hooks, { hooks: { SessionStart: [] } })
  await uninstallStartupHook(paths)
  assert.deepEqual(readJson(paths.hooks), { hooks: { SessionStart: [] } })
  writeJson(paths.hooks, {})
  writeFileSync(paths.hookScript, '// user script')
  await assert.rejects(installStartupHook(paths), /Refusing to overwrite/)
  await uninstallStartupHook(paths)
  assert.equal(readFileSync(paths.hookScript, 'utf8'), '// user script')
  rmSync(paths.hookScript)
  await installStartupHook(paths)
  const cfg = readJson(paths.hooks)
  cfg.hooks.SessionStart.push(structuredClone(cfg.hooks.SessionStart[0]))
  writeJson(paths.hooks, cfg)
  await installStartupHook(paths)
  assert.equal(readJson(paths.hooks).hooks.SessionStart.length, 1)
  await uninstallStartupHook(paths)
  assert(!existsSync(paths.hooks))

  // Legacy Antigravity workspace hooks migrate to absolute commands + adjacent policy.
  paths.hookScript = join(fixture, 'search-boost-pre-invocation.mjs')
  writeFileSync(paths.hookScript, '// Antigravity PreInvocation hook — legacy')
  writeJson(paths.hooks, { [STARTUP_HOOK_KEY]: { enabled: true, PreInvocation: [{ type: 'command', command: 'node ./hooks/search-boost-pre-invocation.mjs' }] } })
  await installStartupHook(paths, { kind: 'antigravity' })
  assert.equal(readJson(paths.hooks)[STARTUP_HOOK_KEY].PreInvocation.length, 1)
  assert(readJson(paths.hooks)[STARTUP_HOOK_KEY].PreInvocation[0].command.includes(paths.hookScript.replace(/\\/g, '/')))
  assert.equal(runHook(paths.hookScript, { invocationNum: 0 }).injectSteps.length, 1)
  // Foreign handler inside the same named hook survives removal.
  const agyConfig = readJson(paths.hooks)
  const foreignHandler = { type: 'command', command: 'echo other' }
  agyConfig[STARTUP_HOOK_KEY].PreInvocation.push(foreignHandler)
  writeJson(paths.hooks, agyConfig)
  await uninstallStartupHook(paths, { kind: 'antigravity' })
  assert.deepEqual(readJson(paths.hooks)[STARTUP_HOOK_KEY].PreInvocation, [foreignHandler])
  await assert.rejects(installStartupHook(paths, { kind: 'antigravity' }), /already in use/)
  assert.equal(buildSessionStartCommand('/node path/node', '/hook path/script.mjs'), '"/node path/node" "/hook path/script.mjs"')
  console.log('ok: malformed config, ownership, duplicate cleanup, legacy migration and quoting')

  const pluginScript = fileURLToPath(new URL('../agents/antigravity/plugin/hooks/pre-invocation.mjs', import.meta.url))
  assert.equal(readFileSync(pluginScript, 'utf8'), readFileSync(new URL('../agents/antigravity/hooks/pre-invocation.mjs', import.meta.url), 'utf8'))
  assert.equal(runHook(pluginScript, { invocationNum: 0 }).injectSteps.length, 1)
  assert.deepEqual(runHook(pluginScript, { invocationNum: 1 }), { injectSteps: [] })
  console.log('ok: bundled antigravity hook ships a working adjacent policy')

  // Grok's passive hooks ignore stdout: use rules rather than install a nonfunctional hook.
  await AGENTS.grok.install({ skipGrokPlugin: true })
  assert(readFileSync(PATHS.grok.rule, 'utf8').includes('proactively'))
  assert(!existsSync(join(home, '.grok', 'hooks')))
  await AGENTS.grok.uninstall({ skipGrokPlugin: true })
  console.log('ok: grok uses startup rule fallback')
  console.log('All startup hook tests passed.')
}
