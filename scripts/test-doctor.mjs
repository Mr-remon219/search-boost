/**
 * Unit-style checks for search-boost doctor (isolated temp home).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_IDS } from '../lib/doctor/registry.mjs'
import { runDoctor } from '../lib/doctor/run.mjs'
import { renderHuman } from '../lib/doctor/render.mjs'

let failed = 0

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}

/**
 * @param {(home: string) => Promise<void>|void} fn
 */
async function withIsolatedHome(fn) {
  const home = mkdtempSync(join(tmpdir(), `search-boost-doctor-test-${process.pid}-`))
  const saved = {
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
    SEARCH_BOOST_LAYER: process.env.SEARCH_BOOST_LAYER,
    SEARCH_BOOST_KEYS_FILE: process.env.SEARCH_BOOST_KEYS_FILE,
    SEARCH_BOOST_LAYER_FILE: process.env.SEARCH_BOOST_LAYER_FILE,
  }
  delete process.env.TAVILY_API_KEY
  delete process.env.BRAVE_API_KEY
  delete process.env.EXA_API_KEY
  delete process.env.SEARCH_BOOST_LAYER
  try {
    await fn(home)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
}

function findCheck(report, id) {
  return report.checks.find((c) => c.id === id)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run doctor in a child process so agent paths pick up isolated HOME.
 * @param {string} home
 * @param {string} category
 */
function runDoctorInSubprocess(home, category) {
  const script = `
import { runDoctor } from './lib/doctor/run.mjs';
const { report, exitCode } = await runDoctor({
  silent: true,
  category: ${JSON.stringify(category)},
  homeDir: process.env.HOME,
  env: {
    TAVILY_API_KEY: undefined,
    BRAVE_API_KEY: undefined,
    EXA_API_KEY: undefined,
  },
});
process.stdout.write(JSON.stringify({ report, exitCode }));
`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || `subprocess exit ${r.status}`)
  }
  return JSON.parse(r.stdout.trim())
}

// layer_keys_coherence warn (api, no keys) → exit 2
await withIsolatedHome(async (home) => {
  writeFileSync(join(home, '.search-boost-layer.json'), `${JSON.stringify({ layer: 'api' })}\n`, 'utf8')
  writeFileSync(join(home, '.search-boost-keys.json'), '{}\n', 'utf8')
  const noKeyEnv = {
    TAVILY_API_KEY: undefined,
    BRAVE_API_KEY: undefined,
    EXA_API_KEY: undefined,
  }
  const { report, exitCode } = await runDoctor({
    homeDir: home,
    silent: true,
    category: 'config',
    env: noKeyEnv,
  })
  const check = findCheck(report, 'layer_keys_coherence')
  assert('layer_keys_coherence warn on api without keys', check?.status === 'warn')
  assert('layer_keys_coherence warn exit 2', exitCode === 2)
})

// layer_keys_coherence pass (api with key)
await withIsolatedHome(async (home) => {
  writeFileSync(join(home, '.search-boost-layer.json'), `${JSON.stringify({ layer: 'api' })}\n`, 'utf8')
  writeFileSync(
    join(home, '.search-boost-keys.json'),
    `${JSON.stringify({ tavily: 'tvly-test-key-12345678' })}\n`,
    'utf8',
  )
  const { report } = await runDoctor({
    homeDir: home,
    silent: true,
    category: 'config',
    env: {
      TAVILY_API_KEY: undefined,
      BRAVE_API_KEY: undefined,
      EXA_API_KEY: undefined,
    },
  })
  const check = findCheck(report, 'layer_keys_coherence')
  assert('layer_keys_coherence pass with api + key', check?.status === 'pass')
})

// keys_file_integrity fail (corrupt JSON) → exit 1
await withIsolatedHome(async (home) => {
  writeFileSync(join(home, '.search-boost-keys.json'), '{not-json\n', 'utf8')
  const { report, exitCode } = await runDoctor({
    homeDir: home,
    silent: true,
    category: 'config',
  })
  const check = findCheck(report, 'keys_file_integrity')
  assert('keys_file_integrity fail on corrupt JSON', check?.status === 'fail')
  assert('keys_file_integrity fail exit 1', exitCode === 1)
})

// exit strict (warn + --strict → 1)
await withIsolatedHome(async (home) => {
  writeFileSync(join(home, '.search-boost-layer.json'), `${JSON.stringify({ layer: 'api' })}\n`, 'utf8')
  writeFileSync(join(home, '.search-boost-keys.json'), '{}\n', 'utf8')
  const { exitCode } = await runDoctor({
    homeDir: home,
    silent: true,
    strict: true,
    category: 'config',
    env: {
      TAVILY_API_KEY: undefined,
      BRAVE_API_KEY: undefined,
      EXA_API_KEY: undefined,
    },
  })
  assert('exit strict turns warn into 1', exitCode === 1)
})

// --json shape: summary, checks[], stable ids
await withIsolatedHome(async (home) => {
  const { report, text } = await runDoctor({
    homeDir: home,
    silent: true,
    json: true,
    category: 'runtime',
  })
  assert('--json has summary', report.summary && typeof report.summary.pass === 'number')
  assert('--json has checks array', Array.isArray(report.checks) && report.checks.length > 0)
  assert('--json text is valid JSON', !!JSON.parse(text ?? '{}'))
  for (const id of CHECK_IDS) {
    assert(`registry id stable: ${id}`, typeof id === 'string' && id.length > 0)
  }
  const nodeCheck = findCheck(report, 'node_version')
  assert('--json check has id/category/status/message', !!(
    nodeCheck?.id
    && nodeCheck.category
    && nodeCheck.status
    && nodeCheck.message
  ))
})

// node_version pass (when Node satisfies engines)
{
  const { report } = await runDoctor({ silent: true, category: 'runtime' })
  const check = findCheck(report, 'node_version')
  const nodeOk = check?.status === 'pass'
  if (nodeOk) {
    assert('node_version pass', true)
  } else {
    console.log(`skip: node_version (Node ${process.versions.node} below package minimum)`)
  }
}

// registry drift: quick checks (design spec lists 15 ids)
assert('registry quick check count', CHECK_IDS.length === 15)

// --category probe with no registered checks → exit 2
{
  const { exitCode } = await runDoctor({ silent: true, category: 'probe' })
  assert('probe category empty exit 2', exitCode === 2)
}

// config_paths_writable verifies override parent dirs
await withIsolatedHome(async (home) => {
  const keysDir = join(home, 'custom')
  mkdirSync(keysDir, { recursive: true })
  const keysPath = join(keysDir, 'keys.json')
  const { report } = await runDoctor({
    homeDir: home,
    silent: true,
    category: 'config',
    env: { SEARCH_BOOST_KEYS_FILE: keysPath },
  })
  const check = findCheck(report, 'config_paths_writable')
  assert('config_paths_writable pass with env override', check?.status === 'pass')
})

// render exit footnote distinguishes fail vs strict-warn
{
  const failReport = {
    packageVersion: '0.0.0',
    mode: 'quick',
    timestamp: '',
    summary: { pass: 0, warn: 0, fail: 1, skip: 0, exitCode: 1 },
    checks: [],
  }
  const warnReport = {
    ...failReport,
    summary: { pass: 0, warn: 1, fail: 0, skip: 0, exitCode: 2 },
  }
  const strictReport = {
    ...failReport,
    summary: { pass: 0, warn: 1, fail: 0, skip: 0, exitCode: 1 },
  }
  assert('render exit fail message', renderHuman(failReport).includes('Exit: 1 (failures present)'))
  assert('render exit warn message', renderHuman(warnReport).includes('Exit: 2 (warnings present'))
  assert('render exit strict message', renderHuman(strictReport).includes('Exit: 1 (--strict: warnings treated as failures)'))
}

// agents: claude keep-native (MCP configured, WebSearch not denied)
{
  const home = mkdtempSync(join(tmpdir(), `search-boost-doctor-claude-${process.pid}-`))
  try {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude.json'),
      `${JSON.stringify({ mcpServers: { 'search-boost': { command: 'node', args: ['cli.mjs', 'serve'] } } })}\n`,
      'utf8',
    )
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      `${JSON.stringify({ permissions: { allow: ['mcp__search-boost__*'] } })}\n`,
      'utf8',
    )
    const { report } = runDoctorInSubprocess(home, 'agents')
    const unconfigured = findCheck(report, 'agent_detected_unconfigured')
    assert('claude keep-native not agent_detected_unconfigured', unconfigured?.status === 'pass')
    const native = findCheck(report, 'native_search_mismatch')
    assert('claude keep-native native_search_mismatch warn', native?.status === 'warn')
    const coverage = findCheck(report, 'agent_install_coverage')
    assert('claude keep-native agent_install_coverage pass', coverage?.status === 'pass')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// agents: fresh machine with no agents detected or configured -> warn (not fail)
await withIsolatedHome(async (home) => {
  const { report, exitCode } = runDoctorInSubprocess(home, 'agents')
  const coverage = findCheck(report, 'agent_install_coverage')
  assert('agent_install_coverage warn when none', coverage?.status === 'warn')
  assert('agent_install_coverage none exit 2', exitCode === 2)
})

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\nAll doctor tests passed (${CHECK_IDS.length} registry checks).`)
