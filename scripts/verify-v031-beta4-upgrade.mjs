import { testRoot } from './isolate-tests.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = '/workspace'
const prefix = join(testRoot, 'prefix')
const home = process.env.HOME
const keysPath = join(home, '.search-boost', 'config', 'keys.json')
const canaryPath = join(home, '.search-boost', 'canary.txt')
const mcpPath = join(home, '.config', 'unrelated-mcp.json')
const keysDoc = {
  brave: 'fixture-upgrade-brave',
  'deepseek-search': 'fixture-upgrade-deepseek',
  enabledEngines: ['brave', 'deepseek-search'],
  engines: {
    brave: { baseUrl: 'https://fixture-gateway.example/brave' },
    'deepseek-search': { baseUrl: 'https://api.deepseek.com' },
  },
}
const keysBody = JSON.stringify(keysDoc, null, 2) + '\n'
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

function installedRoot() {
  return join(prefix, 'lib', 'node_modules', 'search-boost')
}

function productRead(label) {
  const root = installedRoot()
  const keysHref = pathToFileURL(join(root, 'lib', 'keys.mjs')).href
  const endpointsHref = pathToFileURL(join(root, 'lib', 'engine-endpoints.mjs')).href
  const code = `
    import { readEngineBaseUrls, readEngineRouting } from ${JSON.stringify(keysHref)};
    import { engineSearchUrl } from ${JSON.stringify(endpointsHref)};
    const bases = readEngineBaseUrls();
    const routing = readEngineRouting();
    process.stdout.write(JSON.stringify({
      brave: bases.brave,
      deepseek: bases['deepseek-search'],
      braveRequest: engineSearchUrl('brave', bases),
      deepseekRequest: engineSearchUrl('deepseek-search', bases),
      enabled: routing.enabledEngines,
    }));
  `
  const read = JSON.parse(run('node', ['--input-type=module', '-e', code]))
  const show = run('node', [join(prefix, 'bin', 'search-boost'), 'config', 'keys', '--show'])
  if (show.includes('fixture-upgrade-brave') || show.includes('fixture-upgrade-deepseek')) throw new Error(`${label}: show printed a raw fixture key`)
  if (read.brave !== 'https://fixture-gateway.example/brave') throw new Error(`${label}: brave base was not read from engines.brave.baseUrl (${read.brave})`)
  if (!read.braveRequest.startsWith('https://fixture-gateway.example/brave')) throw new Error(`${label}: brave request did not use the stored base (${read.braveRequest})`)
  if (!show.includes('https://fixture-gateway.example/brave')) throw new Error(`${label}: show did not print the brave base`)
  if (!Array.isArray(read.enabled) || !read.enabled.includes('brave') || !read.enabled.includes('deepseek-search')) throw new Error(`${label}: whitelist was not read (${JSON.stringify(read.enabled)})`)
  return { ...read, show }
}

function assertStoredDeepseek(label, request) {
  const read = productRead(label)
  if (read.deepseek !== 'https://api.deepseek.com') throw new Error(`${label}: deepseek base was not read from engines.deepseek-search.baseUrl (${read.deepseek})`)
  if (read.deepseekRequest !== request) throw new Error(`${label}: deepseek request is ${read.deepseekRequest}, expected ${request}`)
  console.log(`${label} reads engines.brave.baseUrl and engines.deepseek-search.baseUrl; deepseek request ${read.deepseekRequest}`)
}

function assertUserFiles(label) {
  const keys = statSync(keysPath)
  if ((keys.mode & 0o777) !== 0o600) throw new Error(`${label}: keys mode is ${(keys.mode & 0o777).toString(8)}`)
  if (readFileSync(keysPath, 'utf8') !== keysBody) throw new Error(`${label}: keys bytes changed`)
  if (readFileSync(canaryPath, 'utf8') !== canaryBody) throw new Error(`${label}: canary changed`)
  if (readFileSync(mcpPath, 'utf8') !== mcpBody) throw new Error(`${label}: unrelated MCP config changed`)
  const doc = JSON.parse(readFileSync(keysPath, 'utf8'))
  if (doc.baseUrls) throw new Error(`${label}: top-level baseUrls is not a product field`)
  if (doc.engines?.brave?.baseUrl !== 'https://fixture-gateway.example/brave') throw new Error(`${label}: engines.brave.baseUrl missing`)
  if (doc.engines?.['deepseek-search']?.baseUrl !== 'https://api.deepseek.com') throw new Error(`${label}: engines.deepseek-search.baseUrl missing`)
}

function install(tarball, version, { storedDeepseek = true, expectedBody = keysBody } = {}) {
  mkdirSync(prefix, { recursive: true })
  process.env.npm_config_prefix = prefix
  run('npm', ['install', '--global', '--prefix', prefix, tarball])
  const installed = JSON.parse(readFileSync(join(prefix, 'lib', 'node_modules', 'search-boost', 'package.json'), 'utf8')).version
  if (installed !== version) throw new Error(`installed ${installed}, expected ${version}`)
  const printed = run('node', [join(prefix, 'bin', 'search-boost'), '--version']).trim()
  if (printed !== version) throw new Error(`--version printed ${printed}, expected ${version}`)
  if (readFileSync(keysPath, 'utf8') !== expectedBody) throw new Error(`${version}: install changed keys`)
  if ((statSync(keysPath).mode & 0o777) !== 0o600) throw new Error(`${version}: keys mode changed`)
  if (readFileSync(canaryPath, 'utf8') !== canaryBody || readFileSync(mcpPath, 'utf8') !== mcpBody) throw new Error(`${version}: canary or unrelated MCP changed`)
  if (storedDeepseek) {
    assertUserFiles(version)
    const deepseekRequest = version === '0.3.0' ? 'https://api.deepseek.com/messages' : 'https://api.deepseek.com/v1/tools/search'
    assertStoredDeepseek(version, deepseekRequest)
  } else {
    const read = productRead(version)
    if (read.deepseekRequest !== 'https://api.deepseek.com/v1/tools/search') throw new Error(`${version}: cleared DeepSeek base did not use the beta default (${read.deepseekRequest})`)
    const doc = JSON.parse(expectedBody)
    if (doc.engines?.['deepseek-search']?.baseUrl) throw new Error('expected body still stores a DeepSeek base')
  }
  console.log(`installed ${version} with default scripts; keys bytes stayed, and the package read engines.*.baseUrl`)
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

const tagObject = run('git', ['-C', repo, 'rev-parse', 'v0.3.0']).trim()
const peeled = run('git', ['-C', repo, 'rev-parse', 'v0.3.0^{}']).trim()
const tagType = run('git', ['-C', repo, 'cat-file', '-t', tagObject]).trim()
if (tagObject !== '12428996dd1aef92f0aedf78ed77066fd59cdbec' || tagType !== 'tag') throw new Error(`v0.3.0 tag object is ${tagType} ${tagObject}`)
if (peeled !== '61c428b786230e71d7a84b2c417da4a9ac246d54') throw new Error(`v0.3.0 peels to ${peeled}`)
console.log(`v0.3.0 annotated tag object ${tagObject}; peeled commit ${peeled}`)
const packedRoot = join(tmpdir(), 'sb-v030-pack')
run('rm', ['-rf', packedRoot])
mkdirSync(packedRoot, { recursive: true })
const archivePath = join(tmpdir(), 'v0.3.0.tar')
run('git', ['-C', repo, 'archive', '--format=tar', '-o', archivePath, peeled])
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
console.log('0.3.0 reads the stored engines.deepseek-search.baseUrl and would call https://api.deepseek.com/messages. This is not the 0.3.0 default.')
run('node', [join(prefix, 'bin', 'search-boost'), 'config', 'keys', '--reset-base-url', 'deepseek-search'])
const afterReset = productRead('0.3.0 reset')
if (afterReset.deepseekRequest !== 'https://api.deepseek.com/anthropic/v1/messages') throw new Error(`reset deepseek request is ${afterReset.deepseekRequest}`)
if (afterReset.brave !== 'https://fixture-gateway.example/brave') throw new Error('reset removed the brave base')
const resetDoc = JSON.parse(readFileSync(keysPath, 'utf8'))
if (resetDoc.engines?.['deepseek-search']?.baseUrl) throw new Error('reset left a stored DeepSeek base')
if (resetDoc.engines?.brave?.baseUrl !== 'https://fixture-gateway.example/brave') throw new Error('reset rewrote the brave base')
if (readFileSync(canaryPath, 'utf8') !== canaryBody || readFileSync(mcpPath, 'utf8') !== mcpBody) throw new Error('reset changed canary or unrelated MCP config')
if ((statSync(keysPath).mode & 0o777) !== 0o600) throw new Error('reset changed keys mode')
console.log('clearing only the DeepSeek base makes 0.3.0 call https://api.deepseek.com/anthropic/v1/messages; brave custom base stays')
const resetBody = readFileSync(keysPath, 'utf8')
refresh('0.3.0', resetBody)

function refresh(label, expectedBody = keysBody) {
  let refreshStatus = 'NOT RUN'
  try {
    const out = run('node', [join(prefix, 'bin', 'search-boost'), 'refresh', '-y'])
    refreshStatus = `exit 0: ${out.trim().split('\n').slice(0, 4).join(' | ')}`
  } catch (err) {
    const detail = `${err.stderr || ''}\n${err.stdout || ''}\n${err.message || ''}`.trim().split('\n').slice(0, 8).join(' | ')
    refreshStatus = `NOT RUN as a successful refresh: ${detail}`
  }
  if (readFileSync(keysPath, 'utf8') !== expectedBody) throw new Error(`${label} refresh changed keys`)
  if (readFileSync(canaryPath, 'utf8') !== canaryBody || readFileSync(mcpPath, 'utf8') !== mcpBody) throw new Error(`${label} refresh changed canary or unrelated MCP config`)
  if ((statSync(keysPath).mode & 0o777) !== 0o600) throw new Error(`${label} refresh changed keys mode`)
  console.log(`${label} refresh: ${refreshStatus}`)
}

install(beta4, '0.3.1-beta.4', { storedDeepseek: false, expectedBody: resetBody })
console.log('reinstall of beta.4 after the 0.3.0 reset kept the cleared DeepSeek base and the brave custom base')
