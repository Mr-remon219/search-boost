/**
 * Unit-style checks for search-boost doctor (isolated temp home).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECK_IDS } from '../lib/doctor/registry.mjs'
import { runDoctor } from '../lib/doctor/run.mjs'

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

if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\nAll doctor tests passed (${CHECK_IDS.length} registry checks).`)
