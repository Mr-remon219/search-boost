import { testRoot } from './isolate-tests.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = '/workspace'
const prefix = join(testRoot, 'prefix')
const home = process.env.HOME
const keysPath = join(home, '.search-boost', 'config', 'keys.json')
const canaryPath = join(home, '.search-boost', 'canary.txt')
const mcpPath = join(home, '.config', 'unrelated-mcp.json')
const keysBody = JSON.stringify({
  brave: 'fixture-upgrade-brave',
  enabledEngines: ['brave', 'bing'],
  baseUrls: { brave: 'https://fixture-gateway.example/brave' },
}, null, 2) + '\n'
const canaryBody = 'user-canary-keep\n'
const mcpBody = JSON.stringify({ mcpServers: { unrelated: { command: 'fixture-unrelated' } } }, null, 2) + '\n'

const locked = [
  ['0.3.1-beta.1', '/opt/cursor/artifacts/search-boost-0.3.1-beta.1-cc49eee.tgz', '73906b8767aca9e8587421e95986d15dbef065b419cea2dbf49ce8fdaf2de402'],
  ['0.3.1-beta.2', '/opt/cursor/artifacts/search-boost-0.3.1-beta.2-896c93c.tgz', 'fa8476804d9ebbaec26e9b53dedde76411edd5d94e908ac58666ac40b6ea72c4'],
  ['0.3.1-beta.3', '/opt/cursor/artifacts/search-boost-0.3.1-beta.3-5a2f6da.tgz', 'ff701c297e399cd8414ce3c207e3da986fad1aacc1300d3371051c0b91334d6a'],
]

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function run(cmd, args, cwd = repo) {
  return execFileSync(cmd, args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function assertUserFiles(label) {
  const keys = statSync(keysPath)
  if ((keys.mode & 0o777) !== 0o600) throw new Error(`${label}: keys mode is ${(keys.mode & 0o777).toString(8)}`)
  if (readFileSync(keysPath, 'utf8') !== keysBody) throw new Error(`${label}: keys bytes changed`)
  if (readFileSync(canaryPath, 'utf8') !== canaryBody) throw new Error(`${label}: canary changed`)
  if (readFileSync(mcpPath, 'utf8') !== mcpBody) throw new Error(`${label}: unrelated MCP config changed`)
}

function install(tarball, version) {
  mkdirSync(prefix, { recursive: true })
  process.env.npm_config_prefix = prefix
  run('npm', ['install', '--global', '--prefix', prefix, tarball])
  const installed = JSON.parse(readFileSync(join(prefix, 'lib', 'node_modules', 'search-boost', 'package.json'), 'utf8')).version
  if (installed !== version) throw new Error(`installed ${installed}, expected ${version}`)
  const printed = run('node', [join(prefix, 'bin', 'search-boost'), '--version']).trim()
  if (printed !== version) throw new Error(`--version printed ${printed}, expected ${version}`)
  assertUserFiles(version)
  console.log(`installed ${version} with default scripts; keys mode 0600, whitelist, base URL, canary, and unrelated MCP unchanged`)
}

const beta4 = process.argv[2]
if (!beta4) {
  console.log('NOT RUN: pass the beta.4 tarball path')
  process.exit(2)
}
for (const [version, file, expect] of locked) {
  const got = sha256(file)
  if (got !== expect) throw new Error(`${version} artifact hash ${got} != ${expect}`)
  console.log(`locked ${version} sha256 ${got}`)
}
console.log(`beta.4 tarball sha256 ${sha256(beta4)}`)

mkdirSync(join(home, '.search-boost', 'config'), { recursive: true, mode: 0o700 })
mkdirSync(join(home, '.config'), { recursive: true, mode: 0o700 })
writeFileSync(keysPath, keysBody, { mode: 0o600 })
chmodSync(keysPath, 0o600)
writeFileSync(canaryPath, canaryBody, { mode: 0o600 })
writeFileSync(mcpPath, mcpBody, { mode: 0o600 })

for (const [version, file] of locked) install(file, version)
install(beta4, '0.3.1-beta.4')
refresh('beta.4')
install(locked[2][1], '0.3.1-beta.3')

const packedRoot = join(tmpdir(), 'sb-v030-pack')
run('rm', ['-rf', packedRoot])
mkdirSync(packedRoot, { recursive: true })
const archivePath = join(tmpdir(), 'v0.3.0.tar')
run('git', ['-C', repo, 'archive', '--format=tar', '-o', archivePath, '12428996dd1aef92f0aedf78ed77066fd59cdbec'])
run('tar', ['-x', '-C', packedRoot, '-f', archivePath])
const packedName = run('npm', ['pack', '--ignore-scripts'], packedRoot).trim().split('\n').at(-1)
const packed = join(packedRoot, packedName)
console.log(`packed GitHub v0.3.0 ${packedName} sha256 ${sha256(packed)} (registry 0.3.0 was not used)`)
install(packed, '0.3.0')

const root = join(prefix, 'lib', 'node_modules', 'search-boost')
const engines = readFileSync(join(root, 'lib', 'search', 'engines.js'), 'utf8')
const endpoints = readFileSync(join(root, 'lib', 'engine-endpoints.mjs'), 'utf8')
if (!engines.includes('web_search_20250305') || !engines.includes('anthropic-version') || !engines.includes('x-api-key')) throw new Error('0.3.0 DeepSeek adapter is not the Anthropic messages path')
if (!endpoints.includes('https://api.deepseek.com/anthropic/v1') || !endpoints.includes("'/messages'")) throw new Error('0.3.0 default DeepSeek base or /messages path is missing')
console.log('0.3.0 installed code uses web_search_20250305 and {base}/messages. Default base is https://api.deepseek.com/anthropic/v1.')
console.log('A stored beta base of https://api.deepseek.com would make 0.3.0 call https://api.deepseek.com/messages. Unset it or restore https://api.deepseek.com/anthropic/v1. This run did not rewrite keys. Custom non-DeepSeek bases stay as stored.')
refresh('0.3.0')
console.log('keys, whitelist, custom base URL, canary, and unrelated MCP still match the bytes written before any install')

function refresh(label) {
  let refreshStatus = 'NOT RUN'
  try {
    const out = run('node', [join(prefix, 'bin', 'search-boost'), 'refresh', '-y'])
    refreshStatus = `exit 0: ${out.trim().split('\n').slice(0, 4).join(' | ')}`
  } catch (err) {
    const detail = `${err.stderr || ''}\n${err.stdout || ''}\n${err.message || ''}`.trim().split('\n').slice(0, 8).join(' | ')
    refreshStatus = `NOT RUN as a successful refresh: ${detail}`
  }
  assertUserFiles(`after ${label} refresh`)
  console.log(`${label} refresh: ${refreshStatus}`)
}

install(beta4, '0.3.1-beta.4')
console.log('reinstall of beta.4 after 0.3.0 did not overwrite user files')
