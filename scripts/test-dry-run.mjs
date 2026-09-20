#!/usr/bin/env node
// Dry-run contract: `--dry-run` must reach every persistence path, not just the
// agent install. Each case runs the real CLI in an isolated HOME and compares a
// full before/after snapshot (paths, contents, POSIX modes). Printing "dry run"
// is not enough — the filesystem must be untouched.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'cli.mjs')

let count = 0
const test = (name, fn) => { fn(); count++; console.log(`ok: ${name}`) }

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  SEARCH_BOOST_HOME: process.env.SEARCH_BOOST_HOME,
  SEARCH_BOOST_KEYS_FILE: process.env.SEARCH_BOOST_KEYS_FILE,
  SEARCH_BOOST_LAYER_FILE: process.env.SEARCH_BOOST_LAYER_FILE,
  XAI_API_KEY: process.env.XAI_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
}

/** Every path under dir → "kind:mode:content" so a content or mode change is caught. */
function snapshot(dir) {
  const out = new Map()
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        out.set(p, `dir:${(statSync(p).mode & 0o777).toString(8)}`)
        walk(p)
      } else if (entry.isFile()) {
        out.set(p, `file:${(statSync(p).mode & 0o777).toString(8)}:${readFileSync(p, 'utf8')}`)
      } else {
        out.set(p, 'other')
      }
    }
  }
  walk(dir)
  return out
}

function diff(before, after) {
  const changes = []
  for (const [path, value] of after) {
    if (!before.has(path)) changes.push(`created ${path}`)
    else if (before.get(path) !== value) changes.push(`changed ${path}`)
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`removed ${path}`)
  return changes
}

/**
 * Run a CLI command in a fresh isolated HOME with a realistic pre-existing config,
 * and assert that a --dry-run invocation changes nothing.
 * @param {{ name: string, args: string[], seed?: (home: string) => void, expect?: RegExp }} spec
 */
function dryRunCase(spec) {
  const home = mkdtempSync(join(tmpdir(), `sb-dryrun-${process.pid}-`))
  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
    delete process.env.SEARCH_BOOST_KEYS_FILE
    delete process.env.SEARCH_BOOST_LAYER_FILE
    delete process.env.XAI_API_KEY
    delete process.env.TAVILY_API_KEY
    mkdirSync(join(home, '.search-boost', 'config'), { recursive: true })
    // A pre-existing store so "no change" is meaningful (not just "nothing created").
    writeFileSync(join(home, '.search-boost', 'config', 'keys.json'), JSON.stringify({ tavily: 'tvly-seed-123456', enabledEngines: ['tavily'] }, null, 2) + '\n')
    writeFileSync(join(home, '.search-boost', 'config', 'layer.json'), JSON.stringify({ layer: 'free' }, null, 2) + '\n')
    spec.seed?.(home)
    const before = snapshot(home)
    const out = execFileSync(process.execPath, [cli, ...spec.args], {
      encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    const after = snapshot(home)
    const changes = diff(before, after)
    assert.deepEqual(changes, [], `${spec.name}: --dry-run must not touch the filesystem (${changes.join('; ')})`)
    if (spec.expect) assert.match(out, spec.expect, `${spec.name}: output should state the dry run`)
    return out
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

try {
  test('setup --dry-run -y writes nothing (including the default layer)', () => {
    const out = dryRunCase({ name: 'setup', args: ['setup', '--dry-run', '-y'], expect: /dry-run/ })
    assert.match(out, /Dry run complete|No agents selected|dry-run/)
  })

  test('install --dry-run -y writes nothing', () => {
    dryRunCase({ name: 'install', args: ['install', '--dry-run', '-y'] })
  })

  test('config layer --dry-run writes nothing', () => {
    dryRunCase({ name: 'config layer', args: ['config', 'layer', '--layer', 'api', '--dry-run'], expect: /dry-run/ })
  })

  test('config keys --engines --dry-run writes nothing', () => {
    dryRunCase({ name: 'config keys --engines', args: ['config', 'keys', '--engines', 'exa', '--dry-run'], expect: /dry-run/ })
  })

  test('config keys --set --dry-run writes nothing', () => {
    dryRunCase({ name: 'config keys --set', args: ['config', 'keys', '--set', 'exa=exa-dry-run-123456', '--dry-run'], expect: /dry-run/ })
  })

  test('config keys --unset --dry-run writes nothing', () => {
    dryRunCase({ name: 'config keys --unset', args: ['config', 'keys', '--unset', 'tavily', '--dry-run'], expect: /dry-run/ })
  })

  test('config keys --disable --dry-run writes nothing', () => {
    dryRunCase({ name: 'config keys --disable', args: ['config', 'keys', '--disable', 'tavily', '--dry-run'], expect: /dry-run/ })
  })

  test('config jev --dry-run writes nothing', () => {
    dryRunCase({
      name: 'config jev set',
      args: ['config', 'jev', '--jev-base-url', 'https://api.typesafe.ai/v1', '--jev-api-key', 'sk-dry-run-123456', '--dry-run'],
      expect: /dry-run/,
    })
  })

  test('config jev --clear --dry-run writes nothing', () => {
    dryRunCase({
      name: 'config jev clear',
      args: ['config', 'jev', '--clear', '--dry-run'],
      seed: (home) => writeFileSync(
        join(home, '.search-boost', 'config', 'keys.json'),
        JSON.stringify({ tavily: 'tvly-seed-123456', jev: { baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'sk-seed-123456' } }, null, 2) + '\n',
      ),
      expect: /dry-run/,
    })
  })

  test('config x --import-grok --dry-run writes nothing', () => {
    dryRunCase({
      name: 'config x import',
      args: ['config', 'x', '--import-grok', '--dry-run'],
      seed: (home) => {
        mkdirSync(join(home, '.grok'), { recursive: true })
        writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({ 'issuer::client': { key: 'grok-fixture-key', refresh_token: 'grok-fixture-refresh' } }))
      },
      expect: /dry-run/,
    })
  })

  test('config x --logout --dry-run writes nothing', () => {
    dryRunCase({
      name: 'config x logout',
      args: ['config', 'x', '--logout', '--dry-run'],
      seed: (home) => writeFileSync(join(home, '.search-boost', 'config', 'xauth.json'), JSON.stringify({ key: 'xai-fixture-123456' })),
      expect: /dry-run/,
    })
  })

  test('a real (non-dry) config write still works, so the guard is not a blanket no-op', () => {
    const home = mkdtempSync(join(tmpdir(), `sb-dryrun-real-${process.pid}-`))
    try {
      process.env.HOME = home
      process.env.USERPROFILE = home
      process.env.SEARCH_BOOST_HOME = join(home, '.search-boost')
      execFileSync(process.execPath, [cli, 'config', 'keys', '--engines', 'exa'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
      const doc = JSON.parse(readFileSync(join(home, '.search-boost', 'config', 'keys.json'), 'utf8'))
      assert.deepEqual(doc.enabledEngines, ['exa'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

console.log(`\n${count} dry-run tests passed.`)
