// Temporary user-session recorder. Production sources are not patched.
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { privateDecrypt, constants } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
const root = process.cwd(), out = resolve(process.env.RUNNER_TEMP, 'v021-evidence')
const home = resolve(process.env.RUNNER_TEMP, 'v021-home'), work = resolve(process.env.RUNNER_TEMP, 'v021-work')
for (const p of [out, home, work]) mkdirSync(p, { recursive: true })
const key = privateDecrypt({ key: readFileSync(process.env.PRIVATE_KEY_FILE), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.parse(readFileSync(process.env.ENVELOPE_FILE)).ciphertext, 'base64')).toString()
console.log('::add-mask::' + key)
const scrub = s => String(s).split(key).join('[REDACTED]').replace(/vck_[A-Za-z0-9]+/g, '[REDACTED_KEY]')
function log(action, data) { const line = scrub(JSON.stringify({ at: new Date().toISOString(), action, ...data })); appendFileSync(resolve(out, 'sessions.jsonl'), line + '\n'); console.log(line.slice(0, 1600)) }
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, LANG: 'C.UTF-8' }
function cli(args) { const s = Date.now(); const r = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { env, cwd: work, encoding: 'utf8', timeout: 30000 }); log('CLI ' + scrub(args.join(' ')), { ms: Date.now() - s, code: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message }); return r }
let client
async function call(name, args = {}, timeout = 145000) { const start = Date.now(); try { const result = await client.callTool({ name, arguments: args }, undefined, { timeout }); log('MCP ' + name, { args, ms: Date.now() - start, result }); return result } catch (e) { log('MCP ' + name, { args, ms: Date.now() - start, error: e.message }); return null } }
try {
  log('PROVENANCE', { sha: process.env.GITHUB_SHA, node: process.version, baseline: '9c3d91f40b17f0a4fbab3bc6eb4271408bd3c8e1' })
  cli(['config', 'jev', '--jev-base-url', 'https://ai-gateway.vercel.sh/v1', '--jev-api-key', key])
  cli(['config', 'jev', '--show']); cli(['config', 'layer', 'free'])
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'cli.mjs'), 'serve'], env, cwd: work, stderr: 'pipe' })
  transport.stderr?.on('data', d => appendFileSync(resolve(out, 'mcp.stderr'), scrub(d)))
  client = new Client({ name: 'v021-user-acceptance', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  log('MCP capabilities', { result: await client.readResource({ uri: 'search-boost://capabilities' }) })
  await call('fused_search', { query: 'Node.js AbortSignal.timeout official documentation', engines: ['bing', 'ddg', 'yahoo', 'exa-free'], max_results: 5 })
  await call('adaptive_search', { questions: ['Python asyncio.TaskGroup 是从哪个版本加入的？', 'What does AbortSignal.timeout(delay) return according to Node.js documentation?'] })
  await call('adaptive_search', { questions: ['Which official documentation page specifies the return value of the fictional zqxv-2099 cancellation interface?'] })
  await call('fetch_page', { url: 'https://docs.python.org/3/library/asyncio-task.html', focus: 'TaskGroup' })
  await call('adaptive_search', { questions: ['Find detailed evidence on JavaScript cancellation and memory lifetime in official docs.'] }, 2000)
  await new Promise(r => setTimeout(r, 1000)); await call('search_stats')
  // Run the shipped Pi adapter under the incompatible host-fetch version,
  // with real outbound requests. This is not the full Pi UI/LLM session.
  for (const k of Object.keys(process.env)) if (/SEARCH_BOOST.*KEY|TYPESAFE_API_KEY|AI_GATEWAY_API_KEY/.test(k)) delete process.env[k]
  process.env.HOME = home; process.env.USERPROFILE = home
  try {
    const host = await import(pathToFileURL(resolve(process.env.HOST_UNDICI, 'index.js')).href)
    host.install()
    const { default: adapter } = await import('../adapters/pi/index.js')
    const tools = new Map()
    adapter({ on() {}, registerCommand() {}, registerTool(t) { tools.set(t.name, t) } })
    const invoke = async (name, args) => { const start = Date.now(); try { const result = await tools.get(name).execute('acceptance-' + name, args, AbortSignal.timeout(100000), undefined, {}); log('PI ADAPTER ' + name, { hostUndici: '8.10.2', ms: Date.now() - start, result }) } catch (e) { log('PI ADAPTER ' + name, { ms: Date.now() - start, error: e.message, cause: e.cause?.message }) } }
    await invoke('fused_search', { query: 'Python asyncio TaskGroup official documentation', engines: ['bing', 'ddg', 'yahoo', 'exa-free'], max_results: 5 })
    await invoke('adaptive_search', { questions: ['Does Python list.sort() return None according to the official documentation?'] })
    await invoke('fetch_page', { url: 'https://nodejs.org/api/globals.html', focus: 'AbortSignal.timeout' })
    const { createJevClient } = await import('../lib/jev/client.mjs')
    const control = createJevClient({ baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: key, maxRetries: 0 })
    const typed = await control.ask({ state: 'The supplied official documentation explicitly states that list.sort() modifies a list in place and returns None.', questions: { action: { type: 'choice', instructions: 'Pick the supported next action.', criteria: { stop: 'The supplied material directly answers what list.sort returns.', search: 'The supplied material does not state what list.sort returns.' } } } })
    log('LIVE CHOICE CONTROL', { entries: [...typed.entries], usage: control.usage(), invalidIds: typed.invalidIds, missingIds: typed.missingIds })
  } catch (e) { log('PI OR CHOICE CONTROL ERROR', { message: scrub(e.message), kind: e.kind }) }
  cli(['config', 'jev', '--clear']); await call('adaptive_search', { questions: ['What does list.sort() return?'] })
  log('MCP after clear', { result: await client.readResource({ uri: 'search-boost://capabilities' }) })
} catch (e) { log('SESSION ERROR', { message: e.message }); process.exitCode = 1 }
finally {
  if (client) await client.close()
  const { closeFetchDispatchers } = await import('../lib/search/ipv4-fetch.js'); await closeFetchDispatchers()
  cli(['config', 'jev', '--clear'])
  log('DONE', {})
}
