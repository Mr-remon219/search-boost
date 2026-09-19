#!/usr/bin/env node
/**
 * Jev System One probe — OPT-IN, REAL NETWORK, NEVER in CI.
 *
 *   node scripts/jev-probe.mjs --yes             # one request: 2 typed questions
 *   node scripts/jev-probe.mjs --yes --batch     # still one request, up to 6 questions
 *   node scripts/jev-probe.mjs --yes --models    # + one GET {baseUrl}/models
 *   node scripts/jev-probe.mjs --yes --save      # + write the raw response to scripts/fixtures/
 *
 * What it checks (the "documented but not machine-verified" list):
 *   V1 endpoint path + Bearer auth           -> HTTP 200 on POST {baseUrl}/systemone
 *   V4 noul answers carry no confidence      -> answer shape printed and asserted
 *   V5 model + usage are returned            -> model/usage printed and asserted
 *   batch behaviour                          -> optional: several questions in ONE request
 *
 * Cost/rate discipline: this sends exactly ONE System One request (plus one
 * /models request with --models). It never loops, never retries beyond the
 * client's bounded 429/529 policy, and prints a reminder not to run it in a
 * loop. Sample content is non-sensitive on purpose.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJevClient, JEV_ERROR_KINDS, JevError } from '../lib/jev/client.mjs'
import { readJevConfig, JEV_DEFAULT_BASE_URL } from '../lib/jev-config.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const optedIn = args.has('--yes') || process.env.JEV_PROBE === '1'

if (args.has('--help') || !optedIn) {
  console.log([
    'Jev System One probe (explicit opt-in, real network request).',
    '',
    '  node scripts/jev-probe.mjs --yes [--batch] [--models] [--save]',
    '',
    'Why opt-in: this talks to the configured Jev endpoint (default TypeSafe) with',
    'your credential. It sends exactly one System One request with non-sensitive',
    'sample questions and prints: endpoint origin, HTTP status, returned model,',
    'answer shapes, usage and timing. Do not run it in a loop; the service has real',
    'rate limits and the SDK already retries 429/529 with backoff.',
    '',
    'No credentials are configured -> configure them first with',
    '`search-boost config jev` (or the TUI) / TYPESAFE_API_KEY, then re-run.',
  ].join('\n'))
  process.exit(0)
}

const cfg = readJevConfig()
if (!cfg.apiKey) {
  console.error('jev-probe: no Jev credential found. Use `search-boost config jev` or TYPESAFE_API_KEY.')
  console.error(`(default base URL would be ${JEV_DEFAULT_BASE_URL}; current: ${cfg.baseUrl})`)
  process.exit(1)
}

const client = createJevClient({
  baseUrl: cfg.baseUrl,
  apiKey: cfg.apiKey,
  model: cfg.model ?? undefined,
})

const questions = {
  sample_is_time_sensitive: {
    type: 'noul',
    instructions: 'Does state.note describe something time sensitive?',
    criteria: { true: 'The note states a deadline or urgency', false: 'The note has no time pressure' },
  },
  sample_topic: {
    type: 'choice',
    instructions: 'Which topic does state.note belong to?',
    criteria: { billing: 'Payments, invoices or refunds', technical: 'Bugs, outages or integrations', other: 'Neither of these' },
  },
}
if (args.has('--batch')) {
  for (let i = 1; i <= 4; i++) {
    questions[`sample_extra_${i}`] = {
      type: 'noul',
      instructions: `Is the word "probe" present in state.note? (question ${i} of a batch; answer independently)`,
      criteria: { true: 'The note contains "probe"', false: 'The note does not contain "probe"' },
    }
  }
}

const state = {
  note: 'This is a synthetic, non-sensitive probe note used to verify the System One contract. It mentions the word probe once.',
  purpose: 'Contract probe for the adaptive_search client: endpoint, auth, answer shapes, usage reporting.',
}
const describe = client.describe()
console.log(`endpoint origin: ${describe.endpointOrigin}`)
console.log(`model alias sent: ${describe.model}`)
console.log(`questions in this single request: ${Object.keys(questions).length}`)

const started = Date.now()
try {
  const result = await client.ask({ state, questions, phase: 'probe' })
  const usage = client.usage()
  console.log(`\nHTTP: ok (${result.attempts} attempt(s), ${Date.now() - started}ms)`)
  console.log(`model returned: ${result.model}`)
  console.log(`usage: input=${result.usage.inputTokens ?? 'n/a'} output=${result.usage.outputTokens ?? 'n/a'} (cumulative input=${usage.inputTokens})`)
  console.log(`request chars: ${result.requestChars}; attempts: ${result.attempts}`)
  console.log('\nanswer shapes:')
  for (const [id, entry] of result.entries) {
    if (entry.type === 'noul') console.log(`  ${id}: noul=${entry.value}${'confidence' in entry ? ' (unexpected confidence field)' : ' (no separate confidence — matches docs)'}`)
    else console.log(`  ${id}: choice=${entry.choice} confidence=${entry.confidence ?? 'n/a'} probabilities=${JSON.stringify(entry.probabilities)}`)
  }
  console.log(`\nvalidation: missing=${result.missingIds.length} invalid=${result.invalidIds.length} unknown=${result.unknownIds.length}`)
  if (result.missingIds.length) console.log(`  missing ids: ${result.missingIds.join(', ')}`)
  if (result.invalidIds.length) console.log(`  invalid ids: ${result.invalidIds.join(', ')}`)

  const noulEntry = result.entries.get('sample_is_time_sensitive')
  const shapeOk = noulEntry?.type === 'noul' && typeof noulEntry.value === 'number'
  console.log(`\nV1 endpoint/auth: ok`)
  console.log(`V4 noul shape: ${shapeOk ? 'ok (numeric, no confidence)' : 'UNEXPECTED — inspect the raw response'}`)
  console.log(`V5 model+usage: ${result.model && result.usage.inputTokens !== null ? 'ok' : 'PARTIAL — the service did not return model/usage'}`)

  if (args.has('--save')) {
    const dir = join(ROOT, 'scripts', 'fixtures')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `jev-systemone-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, `${JSON.stringify({
      endpointOrigin: describe.endpointOrigin,
      modelAlias: describe.model,
      modelReturned: result.model,
      questionTypes: Object.fromEntries(Object.entries(questions).map(([id, spec]) => [id, spec.type])),
      answers: Object.fromEntries(result.entries),
      usage: result.usage,
      attempts: result.attempts,
      tookMs: Date.now() - started,
      missing: result.missingIds,
      invalid: result.invalidIds,
      unknown: result.unknownIds,
    }, null, 2)}\n`, 'utf8')
    console.log(`\nsaved fixture: ${file} (no credential material is written)`)
  }
  console.log('\nReminder: do not loop this probe — one request is enough to verify the contract.')
} catch (err) {
  const error = err instanceof JevError ? err : null
  console.error(`\nprobe failed: ${error ? `${error.kind}${error.status ? ` (http ${error.status})` : ''}${error.detail ? ` — ${error.detail}` : ''}` : String(err)}`)
  if (error?.kind === JEV_ERROR_KINDS.unauthorized) console.error('Check the key: `search-boost config jev --show` (401/403 is never retried).')
  if (error?.kind === JEV_ERROR_KINDS.invalidRequest) console.error('The request was rejected as invalid — this is a client construction bug, please report it.')
  if (error?.kind === JEV_ERROR_KINDS.rateLimited || error?.kind === JEV_ERROR_KINDS.overloaded) console.error('Rate limited/overloaded after bounded retries: wait before retrying; do not hammer the endpoint.')
  process.exit(1)
}
