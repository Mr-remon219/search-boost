/**
 * Unit checks for xauth expiry probe (xAuthAvailableSync / isAuthEntryUsable).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAuthEntryUsable } from '../lib/search/xauth.js'
import { xAuthAvailableSync } from '../lib/search/xsearch.js'

let failed = 0

function assert(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`)
    failed++
  } else {
    console.log(`ok: ${name}`)
  }
}

assert('api-key usable', isAuthEntryUsable({ kind: 'api-key', key: 'xai-test123' }))
assert('grok-session without expiry usable', isAuthEntryUsable({ kind: 'grok-session', key: 'tok' }))
assert(
  'expired grok-session not usable',
  !isAuthEntryUsable({
    kind: 'grok-session',
    key: 'tok',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }),
)
assert(
  'future grok-session usable',
  isAuthEntryUsable({
    kind: 'grok-session',
    key: 'tok',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }),
)

const home = mkdtempSync(join(tmpdir(), `search-boost-xauth-test-${process.pid}-`))
const savedHome = process.env.HOME
const savedXauth = process.env.SEARCH_BOOST_XAUTH_FILE
const savedXai = process.env.XAI_API_KEY
process.env.HOME = home
delete process.env.XAI_API_KEY
const xauthFile = join(home, '.search-boost', 'config', 'xauth.json')
mkdirSync(join(home, '.search-boost', 'config'), { recursive: true })
process.env.SEARCH_BOOST_XAUTH_FILE = xauthFile

try {
  writeFileSync(
    xauthFile,
    JSON.stringify({
      kind: 'grok-session',
      key: 'expired-token',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  )
  assert('xAuthAvailableSync false for expired local copy', !xAuthAvailableSync())

  writeFileSync(
    xauthFile,
    JSON.stringify({
      kind: 'grok-session',
      key: 'valid-token',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }),
  )
  assert('xAuthAvailableSync true for valid local copy', xAuthAvailableSync())
} finally {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedXauth === undefined) delete process.env.SEARCH_BOOST_XAUTH_FILE
  else process.env.SEARCH_BOOST_XAUTH_FILE = savedXauth
  if (savedXai === undefined) delete process.env.XAI_API_KEY
  else process.env.XAI_API_KEY = savedXai
  rmSync(home, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nAll xauth tests passed.')
