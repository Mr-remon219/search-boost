#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { codexCliDetected } from '../lib/host-detection.mjs'
import { agentConfigured, agentDetected, codexHomeDir, PATHS } from '../lib/paths.mjs'
import { parseTargetSpec } from '../lib/agents/index.mjs'
import { authStatus } from '../lib/search/x/xauth.js'
import { runXAuthWizard, formatXAuthStatusLines } from '../lib/installer/xauth-wizard.mjs'
import { withTuiContext } from '../lib/installer/i18n.mjs'
import { runDshInstallTransaction } from '../lib/dsh-profile-transaction.mjs'
import { PKG_ROOT, getVersion } from '../lib/pkg.mjs'

for (const result of [
  { status: 0, stdout: 'codex-cli 0.114.0\n' },
  { status: 0, stdout: 'codex 1.2.3-beta.1\n' },
]) assert(codexCliDetected({ run: () => result }))
for (const result of [
  { status: 97, stdout: 'codex-cli 0.114.0' },
  { status: 0, stdout: 'some unrelated executable' },
  { status: 0, stdout: '' },
  { status: null, error: new Error('ENOENT') },
  { status: null, error: new Error('ETIMEDOUT') },
]) assert.equal(codexCliDetected({ run: () => result }), false)
assert.equal(codexCliDetected({ run: () => { throw new Error('failed spawn') } }), false)
codexCliDetected({ platform: 'win32', env: { COMSPEC: 'fixture-cmd.exe' }, run: (command, args, opts) => {
  assert.equal(command, 'fixture-cmd.exe')
  assert.deepEqual(args, ['/d', '/s', '/c', 'codex --version'])
  assert.equal(opts.timeout, 1500)
  assert.equal(opts.windowsHide, true)
  return { status: 0, stdout: 'codex-cli 1.2.3' }
} })
mkdirSync(codexHomeDir(), { recursive: true })
assert.equal(agentDetected('codex'), false, 'empty Codex directory is not a host installation')
writeFileSync(PATHS.codex.config, '[mcp_servers.search-boost]\ncommand = "node"\nargs = ["fixture.mjs"]\n')
assert.equal(agentConfigured('codex'), true)
assert.equal(agentDetected('codex'), false, 'SearchBoost config does not install Codex')
assert(!parseTargetSpec('auto').includes('codex'), 'automatic targets exclude absent Codex')
const bin = join(process.env.HOME, 'feedback-bin')
mkdirSync(bin)
const command = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex')
writeFileSync(command, process.platform === 'win32' ? '@echo codex-cli 0.114.0\r\n@exit /b 0\r\n' : '#!/bin/sh\nprintf "codex-cli 0.114.0\\n"\n')
chmodSync(command, 0o755)
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
assert.equal(agentDetected('codex'), true, 'working Codex CLI is detected after PATH changes')
assert(parseTargetSpec('auto').includes('codex'))
console.log('ok: Codex detection verifies a working CLI, not empty or SearchBoost-created state; errors/timeouts fail closed')

assert.equal(authStatus().source, 'none')
assert(authStatus().detail.includes('keyless X fallback'))
for (const language of ['en', 'zh-CN']) {
  const logs = []
  await withTuiContext(async () => {
    await runXAuthWizard({ select: async () => 'keep', isCancel: () => false, log: { info: s => logs.push(s) } })
    logs.push(...formatXAuthStatusLines())
  }, { language })
  assert(logs.some(s => language === 'en' ? /without an X\/xAI API key or paid API subscription/.test(s) : /无需先配置 X\/xAI API Key 或付费 API 订阅/.test(s)))
  assert(logs.some(s => language === 'en' ? /keyless.*best-effort/.test(s) : /免凭据.*尽力获取/.test(s)))
}
console.log('ok: X guidance explicitly explains keyless fallback and optional official credentials in both languages')

const atomic = {
  withFileLock: async (_path, fn) => fn(),
  writeFileAtomic: async (path, bytes) => writeFileSync(path, bytes),
}
for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies', 'ignored-save-flags']) {
  const dir = join(process.env.HOME, `dsh-feedback-${field}`)
  mkdirSync(dir)
  const before = JSON.stringify({ name: 'feedback-profile', dependencies: { 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: ['user-plugin'] } } })
  writeFileSync(join(dir, 'package.json'), before)
  const config = 'save-peer=true\nsave-dev=true\n'
  writeFileSync(join(dir, '.npmrc'), config)
  let observed
  const operations = {
    runProfilePnpm: async (_context, args) => {
      observed = args
      assert(args.includes('--save-prod'))
      for (const flag of ['--save-dev=false', '--save-peer=false', '--save-optional=false']) assert(args.includes(flag))
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      // Simulate a profile with a non-production save default. Explicit flags
      // override it; an unsupported manager that ignores them must roll back.
      const edge = field === 'ignored-save-flags' ? 'peerDependencies' : 'dependencies'
      pkg[edge] ??= {}
      pkg[edge]['search-boost'] = args.at(-1)
      pkg.dsh.profile.bundles.push('search-boost')
      mkdirSync(join(dir, 'node_modules'))
      symlinkSync(PKG_ROOT, join(dir, 'node_modules', 'search-boost'), process.platform === 'win32' ? 'junction' : 'dir')
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
      return { exitCode: 0 }
    },
  }
  const result = await runDshInstallTransaction({
    boot: { resolveBundleDir: () => join(dir, 'node_modules', 'search-boost') }, atomic, operations, dir,
    profile: 'feedback', anchor: join(dir, 'host.json'), spec: PKG_ROOT, sourceRoot: PKG_ROOT,
    version: getVersion(), enable: false, desktop: false, backupHome: join(process.env.HOME, 'feedback-backups'),
  })
  assert.equal(observed.at(-1), PKG_ROOT)
  assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), config, 'pnpm defaults remain unchanged')
  assert(!existsSync(join(dir, '.search-boost-install-pending.json')))
  if (field === 'ignored-save-flags') {
    assert.equal(result.error, 'install-failed-restored')
    assert.equal(result.failure, 'registration')
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
    assert(!existsSync(join(dir, 'node_modules')))
  } else {
    assert.equal(result.error, undefined)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies['search-boost'], PKG_ROOT, 'DSH Installed view sees the production edge')
    assert.equal(pkg.dependencies['user-plugin'], '1.0.0')
    assert.equal(result.enabled, true)
  }
}
console.log('ok: DSH install explicitly saves a production dependency and verifies the UI-visible edge; ignored flags roll back without changing pnpm settings or host peers')
