// Runs before installer imports. Tests must not read/write a developer's real
// HOME, relocated stores, login files, or provider keys.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'sb-install-isolated-'))
for (const key of Object.keys(process.env)) {
  if (/^(SEARCH_BOOST_|PI_SEARCH_|PI_CODING_AGENT_DIR$|DSH_HOME$)/.test(key) || /^(TAVILY_API_KEY|BRAVE_API_KEY|EXA_API_KEY|XAI_API_KEY|TYPESAFE_API_KEY|AI_GATEWAY_API_KEY)$/.test(key)) delete process.env[key]
}
process.env.HOME = process.env.USERPROFILE = home
process.on('exit', () => { rmSync(home, { recursive: true, force: true }) })
