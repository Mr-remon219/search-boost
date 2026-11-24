import './isolate-tests.mjs'
// Frozen-label ablation for the N_off screening flow: value-only admission, the
// prototype formula, source discount, preferences and near-duplicate folding.
//
// The pools and labels are the same frozen development fixture as before. What
// changed with N_off is the admission rule: the old per-material conditions gate
// is GONE, so material the fixture labelled tool.scope='not_passed' is now judged
// on the reading-value rubric alone. The fixture's gold.scope/undecidable axis is
// no longer an admission input; it is still reported to show where the labels
// disagree with the delivered set. Simulated rescue notes in the fixture are NOT
// consumed: the N_off flow has no automatic page read.
//
// HONEST LIMITS (printed at the end): metrics are computed from the same gold
// value field the ranking consumes, so "new ≥ old" is largely label-derived; the
// shipped params are the design's EXAMPLE values, not calibrated; every
// same-cluster fold pair shares a URL stem, so fold recall is in-sample and
// cross-slug mirror misses are unmeasured; folding stays opt-in (dedupe=false).
import assert from 'node:assert/strict'
import { POOLS, PREFERENCE_MATCH_VALUE } from './screening-ablation-fixture.mjs'
import { admitAndRank, runScreening } from '../lib/search/screening/controller.js'
import { decodeScreening } from '../lib/search/screening/judgments.js'
import { screeningScore, DEFAULT_SCREENING_PARAMS } from '../lib/search/screening/scoring.js'
import { foldsInto, docStem } from '../lib/search/screening/duplicates.js'
import { eligibleDiscountOptions, validateSourceBiasPolicy } from '../lib/search/screening/policy.js'

const K = 5
const EPSILON = 0.1

// Declared test policy — policy_preference only, NOT a validated quality claim:
// for documentation questions, generic web-search channels merit a discount.
const GENERIC_WEB_POLICY = validateSourceBiasPolicy({
  version: 'ablation-generic-web-v1',
  nature: 'policy_preference',
  mildEligible: ['bing', 'ddg', 'exa-free', 'anysearch'],
  strongEligible: ['bing', 'ddg'],
})

const STRONGEST = ['strong', 'mild', 'none']
const discountOption = (candidate, policy) => {
  const { options } = eligibleDiscountOptions(policy, candidate.engines)
  return STRONGEST.find((option) => options.includes(option)) ?? 'unknown'
}

// Old multiplier model kept only as the comparison baseline: S = B(VD + C).
const OLD_V = { 3: 1, 4: 1.2, 5: 1.4 }
const oldScore = (candidate, label, { discount = 'none', usePref = false }) => {
  const D = discount === 'none' ? 1 : discount === 'mild' ? 0.9 : 0.75
  const C = usePref ? 0.1 * PREFERENCE_MATCH_VALUE[label.pref] : 0
  return candidate.B * (OLD_V[label.value] * D + C)
}
const newScore = (candidate, label, { discount = 'none', usePref = false }) => screeningScore({
  baseScore: candidate.B, valueLevel: label.value, discount,
  preferenceMatches: [label.pref],
}, { ...DEFAULT_SCREENING_PARAMS, epsilon: usePref ? EPSILON : 0 }).finalScore

const byScoreThenId = (a, b) => b.score - a.score || a.id.localeCompare(b.id)
const clusterOf = (pool, id) => pool.candidates.find((c) => c.id === id).cluster

/** Greedy near-duplicate folding: keep the top-scored representative per document. */
function fold(pool, ordered) {
  const kept = []
  const collapsed = []
  for (const item of ordered) {
    const candidate = pool.candidates.find((c) => c.id === item.id)
    const representative = kept.find((k) => {
      const other = pool.candidates.find((c) => c.id === k.id)
      return foldsInto(candidate, other) || foldsInto(other, candidate)
    })
    if (representative) collapsed.push({ id: item.id, into: representative.id })
    else kept.push(item)
  }
  return { kept, collapsed }
}

function metrics(pool, orderedIds) {
  const gold = (id) => pool.candidates.find((c) => c.id === id).gold
  const top = orderedIds.slice(0, K)
  // N_off gain is the value rubric alone; gold.scope is NOT an admission rule.
  const gain = (id) => gold(id).value ?? 0
  const dcg = top.reduce((sum, id, i) => sum + gain(id) / Math.log2(i + 2), 0)
  const ideal = [...pool.candidates].map((c) => gain(c.id)).sort((a, b) => b - a).slice(0, K)
  const idcg = ideal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  // Document-level nDCG: each underlying document counts its value once, so URL
  // mirrors of one page cannot inflate the score.
  const seen = new Set()
  let dDcg = 0
  for (const [i, id] of top.entries()) {
    const cluster = clusterOf(pool, id)
    dDcg += (seen.has(cluster) ? 0 : gain(id)) / Math.log2(i + 2)
    seen.add(cluster)
  }
  const perCluster = new Map()
  for (const c of pool.candidates) perCluster.set(c.cluster, Math.max(perCluster.get(c.cluster) ?? 0, gain(c.id)))
  const dIdeal = [...perCluster.values()].sort((a, b) => b - a).slice(0, K)
  const dIdcg = dIdeal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  const firstKey = top.findIndex((id) => gold(id).value >= 4)
  return {
    returned: orderedIds.length,
    useful: top.filter((id) => gold(id).value >= 3).length,
    key: top.filter((id) => gold(id).value >= 4).length,
    firstKey: firstKey < 0 ? null : firstKey + 1,
    ndcg: idcg ? dcg / idcg : 1,
    docNdcg: dIdcg ? dDcg / dIdcg : 1,
    // Honesty axis, NOT an admission rule: how many delivered rows the fixture
    // gold labels as conditions-not-established (or explicitly failing).
    goldScopeDisagreement: top.filter((id) => gold(id).scope !== 'pass').length,
    distinct: new Set(top.map((id) => clusterOf(pool, id))).size,
    poolUseful: pool.candidates.filter((c) => c.gold.value >= 3).length,
  }
}
const fmt = (m) => `useful@${K}=${m.useful} key@${K}=${m.key} firstKey=${m.firstKey ?? '—'} ndcg=${m.ndcg.toFixed(3)} docNdcg=${m.docNdcg.toFixed(3)} goldScopeDisagreement=${m.goldScopeDisagreement} distinct@${K}=${m.distinct} n=${m.returned} recall=${m.poolUseful ? (m.useful / m.poolUseful).toFixed(2) : '—'}`

async function runPool(pool) {
  // The fixture's tool labels are re-interpreted for N_off: only the value level
  // and preference match survive; scope/info/constraints are not consulted.
  const candidates = pool.candidates.map((c) => ({
    evidenceId: c.id, key: c.url, url: c.url, title: c.title, text: c.text,
    basis: 'engine_snippet', baseScore: c.B, engines: c.engines, safetyState: 'clear',
  }))
  const byId = new Map(pool.candidates.map((c) => [c.id, c]))
  const decoded = new Map()
  const judgedIds = []
  const controller = await runScreening({
    candidates, question: pool.question, intent: pool.intent,
    preferences: pool.preferences, policy: GENERIC_WEB_POLICY, maxResults: 20, dedupe: false,
    judge: async (request) => {
      const entries = new Map(request.mapping.filter((m) => Object.hasOwn(request.questions, m.id)).map((m) => {
        const c = byId.get(m.candidateId)
        judgedIds.push(m.candidateId)
        const option = m.kind === 'value' ? String(c.tool.value)
          : m.kind === 'discount' ? discountOption(c, GENERIC_WEB_POLICY) : c.tool.pref
        return [m.id, { type: 'choice', choice: option }]
      }))
      for (const [id, judgement] of decodeScreening(entries, request.mapping)) decoded.set(id, judgement)
      return entries
    },
  })
  const label = (c) => {
    const j = decoded.get(c.id)
    return { value: j.value.state === 'level' ? j.value.level : j.value.state, pref: j.preferences[0] }
  }
  const admitted = pool.candidates.filter((c) => typeof label(c).value === 'number' && label(c).value >= 3)
  const rank = (scoreOf, options = {}) => admitted
    .map((c) => ({ id: c.id, score: scoreOf(c, label(c), options) }))
    .sort(byScoreThenId).map((x) => x.id)
  const rankB = pool.candidates.map((c) => ({ id: c.id, score: c.B })).sort(byScoreThenId).map((x) => x.id)
  const rankAdmittedB = admitted.map((c) => ({ id: c.id, score: c.B })).sort(byScoreThenId).map((x) => x.id)
  const discountOf = (c) => discountOption(c, GENERIC_WEB_POLICY)
  const dpNewPlain = rank((c, l) => newScore(c, l, {}))
  const dpOldPlain = rank((c, l) => oldScore(c, l, {}))
  const dpNewD = rank((c, l) => newScore(c, l, { discount: discountOf(c) }))
  const dpOldD = rank((c, l) => oldScore(c, l, { discount: discountOf(c) }))
  const dpNewP = rank((c, l) => newScore(c, l, { usePref: true }))
  const dpOldP = rank((c, l) => oldScore(c, l, { usePref: true }))
  const dpNew = rank((c, l) => newScore(c, l, { discount: discountOf(c), usePref: true }))
  const dpOld = rank((c, l) => oldScore(c, l, { discount: discountOf(c), usePref: true }))
  const foldedNew = fold(pool, dpNew.map((id) => ({ id })))
  const foldedOld = fold(pool, dpOld.map((id) => ({ id })))
  return {
    label, admitted, controller, judgedIds, dpNew, dpOld, dpNewPlain, dpOldPlain, dpNewD, dpNewP, dpOldD, dpOldP,
    rows: [
      ['F            fused B order      ', rankB],
      ['FV           admitted, B order  ', rankAdmittedB],
      ['FV-old       re-rank old formula', dpOldPlain],
      ['FV-new       re-rank new formula', dpNewPlain],
      ['FV-old+D     discount only(old) ', dpOldD],
      ['FV-new+D     discount only(new) ', dpNewD],
      ['FV-old+P     preference only(old)', dpOldP],
      ['FV-new+P     preference only(new)', dpNewP],
      ['FVDP-old     +D+P old formula   ', dpOld],
      ['FVDP-new     +D+P new formula   ', dpNew],
      ['FVDP-old+fold  near-dup fold    ', foldedOld.kept.map((x) => x.id)],
      ['FVDP-new+fold  near-dup fold    ', foldedNew.kept.map((x) => x.id)],
    ],
    collapsed: foldedNew.collapsed,
    collapsedOld: foldedOld.collapsed,
  }
}

// ------------------------------------------------------------------ report --
const results = {}
for (const pool of POOLS) {
  const conditionBlockedHighValue = pool.candidates.filter((c) => c.tool.scope === 'not_passed' && typeof c.tool.value === 'number' && c.tool.value >= 4).map((c) => c.id)
  const undecidedHighValue = pool.candidates.filter((c) => c.gold.scope !== 'pass' && c.gold.value >= 4).map((c) => c.id)
  const snippetMiss = pool.candidates.filter((c) => c.gold.value >= 3 && !(typeof c.tool.value === 'number' && c.tool.value >= 3)).map((c) => c.id)
  console.log(`\n=== pool ${pool.id}: ${pool.question} ===`)
  console.log(`pool stats: candidates=${pool.candidates.length} old-gate-blocked-high-value=[${conditionBlockedHighValue.join(',')}] gold-non-pass-high-value=[${undecidedHighValue.join(',')}] snippet-insufficiency-miss=[${snippetMiss.join(',')}]`)
  const run = await runPool(pool)
  console.log(`  controller: judgeCalls=${run.controller.diagnostics.judgeCalls} collected=${run.controller.diagnostics.collected} qualityAssessed=${run.controller.diagnostics.qualityAssessed} safetyUnavailable=${run.controller.diagnostics.safetyUnavailable}; no rescue read exists (fixture rescue notes intentionally unused)`)
  assert.deepEqual(run.controller.results.map((r) => r.evidenceId), run.dpNew, 'the real controller must reproduce the replay admission/ranking')
  assert.ok(run.controller.results.every((row) => row.valueLevel >= 3), 'N_off admits value 3/4/5 only')
  assert.equal(run.controller.results.length, run.admitted.length)
  for (const [name, ids] of run.rows) console.log(`  ${name}  ${fmt(metrics(pool, ids))}`)
  if (run.collapsed.length) console.log(`  folded: ${run.collapsed.map((d) => `${d.id}→${d.into}`).join(' ')}`)
  results[pool.id] = run
  const dEffect = run.dpNewPlain.join() !== run.dpNewD.join()
  const pEffect = run.dpNewPlain.join() !== run.dpNewP.join()
  console.log(`  D-only ${dEffect ? 'changes the order' : 'no measurable rank effect'}; P-only ${pEffect ? 'changes the order' : 'no measurable rank effect'}`)
}

// -------------------------------------------------------- parameter context --
{
  const { tau, lambda, utilities: u } = DEFAULT_SCREENING_PARAMS
  const allB = POOLS.flatMap((p) => p.candidates.map((c) => c.B)).sort((a, b) => a - b)
  const bOf = (B) => B / (B + tau)
  const minB = allB[0], maxB = allB[allB.length - 1]
  const maxGap = bOf(maxB) - bOf(minB)
  const lambdaLimit = (du) => du / (du + maxGap)
  console.log(`\nparameter context (tau=${tau}, lambda=${lambda}, u=example values, NOT calibrated):`)
  console.log(`  recorded B ${minB.toFixed(4)}..${maxB.toFixed(4)} → b ${bOf(minB).toFixed(4)}..${bOf(maxB).toFixed(4)}; any recorded base gap Δb ≤ ${maxGap.toFixed(4)}`)
  console.log(`  a one-level value gap beats ANY recorded base gap when lambda < Δu/(Δu+Δb): u3→4=${lambdaLimit(u['4'] - u['3']).toFixed(3)} u4→5=${lambdaLimit(u['5'] - u['4']).toFixed(3)} u3→5=${lambdaLimit(u['5'] - u['3']).toFixed(3)}; current lambda=${lambda}`)
}

// -------------------------------------------------------------- label audit --
{
  const rows = POOLS.flatMap((p) => results[p.id].admitted)
  const disagreement = rows.filter((c) => c.gold.scope !== 'pass' && c.gold.value >= 3)
  const agreement = rows.filter((c) => c.tool.value === c.gold.value).length
  console.log(`\nlabel audit: delivered ${rows.length} rows; tool/gold value agreement ${agreement}/${rows.length}; gold-non-pass-but-delivered=[${disagreement.map((c) => c.id).join(',')}] (admission no longer consults gold.scope)`)
  console.log('  → rankings consume the same value field the metric gain uses: "new ≥ old" is label-derived, not an independent quality result')
}

// ----------------------------------------------- documented ablation traps --
{
  const run = results.C
  const noFold = metrics(POOLS[2], run.dpNew)
  const withFold = metrics(POOLS[2], fold(POOLS[2], run.dpNew.map((id) => ({ id }))).kept.map((x) => x.id))
  const oldFold = metrics(POOLS[2], fold(POOLS[2], run.dpOld.map((id) => ({ id }))).kept.map((x) => x.id))
  console.log(`\npool C mirror stacking: unfolder distinct@${K}=${noFold.distinct} docNdcg=${noFold.docNdcg.toFixed(3)} → folded distinct@${K}=${withFold.distinct} docNdcg=${withFold.docNdcg.toFixed(3)}`)
  console.log(`  attribution: the OLD order folded gives distinct@${K}=${oldFold.distinct} docNdcg=${oldFold.docNdcg.toFixed(3)} too — this pool's diversity gain is a fold effect`)
  for (const [tag, newer, older] of [['FV (no D/P)', run.dpNewPlain, run.dpOldPlain], ['FVDP', run.dpNew, run.dpOld]]) {
    const a = metrics(POOLS[2], newer).docNdcg, b = metrics(POOLS[2], older).docNdcg
    const relation = Math.abs(a - b) < 1e-12 ? '=' : a < b ? '<' : '>'
    console.log(`  ${tag} docNdcg: new ${a.toFixed(3)} ${relation} old ${b.toFixed(3)}; delta=${(a - b).toFixed(6)}`)
  }
  assert.ok(withFold.distinct > noFold.distinct, 'folding must improve first-screen document diversity')
  assert.ok(withFold.docNdcg >= noFold.docNdcg - 1e-12, 'folding must not lose document-level nDCG')
  assert.equal(oldFold.distinct, withFold.distinct, 'fold effect must not be attributed to the formula')
}

// -------------------------------------- near-duplicate folding correctness --
// foldsInto must agree with the fixture's document identity, including the
// traps: two different `duckdb-vs-sqlite` articles sharing a URL basename
// (A1/A2), MDN vs Node.js AbortSignal pages with similar titles (B3/B5), two
// patch snapshots of one manual (B9/B10 fold), a third-party page quoting the
// man page verbatim (C8), and a versioned docs path (C9 folds into C1).
const foldChecks = [
  ['A', 'A1', 'A2'], ['A', 'A1', 'A3'], ['B', 'B3', 'B5'], ['B', 'B2', 'B9'],
  ['B', 'B9', 'B10'], ['C', 'C1', 'C2'], ['C', 'C1', 'C3'], ['C', 'C1', 'C4'],
  ['C', 'C1', 'C8'], ['C', 'C1', 'C9'], ['C', 'C1', 'C10'], ['B', 'B6', 'B8'],
]
for (const [poolId, a, b] of foldChecks) {
  const pool = POOLS.find((p) => p.id === poolId)
  const left = pool.candidates.find((c) => c.id === a)
  const right = pool.candidates.find((c) => c.id === b)
  const folded = foldsInto(left, right) || foldsInto(right, left)
  console.log(`fold check ${poolId}:${a}/${b} gold=${left.cluster === right.cluster ? 'same-doc' : 'distinct'} heuristic=${folded ? 'fold' : 'keep'}`)
  assert.equal(folded, left.cluster === right.cluster, `${poolId}:${a}/${b} folding must match fixture document identity`)
}
assert.equal(docStem('https://git-scm.com/docs/git-sparse-checkout/2.55.0'),
  docStem('https://git-scm.com/docs/git-sparse-checkout'),
  'versioned docs path must share the canonical document stem')
console.log(`fold checks: ${foldChecks.length} pairs PASS — but IN-SAMPLE (thresholds chosen on these same pairs); folding stays opt-in`)

// ------------------------------------------------------------- invariants --
for (const pool of POOLS) {
  const run = results[pool.id]
  const pick = (tag) => metrics(pool, run.rows.find(([name]) => name.includes(tag))[1])
  const oldF = pick('FV-old'), newF = pick('FV-new')
  assert.ok(newF.ndcg >= oldF.ndcg - 1e-12, `${pool.id}: new formula nDCG must not lose to old`)
  assert.ok((newF.firstKey ?? 99) <= (oldF.firstKey ?? 99), `${pool.id}: new formula must not rank key evidence later`)
  const oldDP = metrics(pool, run.dpOld), newDP = metrics(pool, run.dpNew)
  assert.ok(newDP.ndcg >= oldDP.ndcg - 1e-12, `${pool.id}: new+D+P nDCG must not lose to old+D+P`)
  // delivered rows are exactly the value>=3 rows; nothing is admitted on scope
  assert.deepEqual([...run.controller.results].map((r) => r.valueLevel >= 3), run.controller.results.map(() => true))
}

// --------------------------------------------------- production cross-check --
// admitAndRank must reproduce this runner's FVDP-new order on identical input,
// and its dedupe option must reproduce greedy near-duplicate folding while
// staying OFF by default.
for (const pool of POOLS) {
  const run = results[pool.id]
  const candidates = pool.candidates.map((c) => ({
    evidenceId: c.id, key: c.url, url: c.url, title: c.title, text: c.text,
    baseScore: c.B, engines: c.engines, safetyState: 'clear',
  }))
  const judgements = new Map(pool.candidates.map((c) => {
    const l = run.label(c)
    return [c.id, {
      value: typeof l.value === 'number' ? { state: 'level', level: l.value } : { state: l.value },
      discount: { state: 'selected', option: discountOption(c, GENERIC_WEB_POLICY) },
      preferences: [l.pref],
    }]
  }))
  const options = { candidates, judgements, preferences: pool.preferences, policy: GENERIC_WEB_POLICY, maxResults: 20 }
  assert.deepEqual(admitAndRank({ ...options, dedupe: false }).results.map((r) => r.evidenceId), run.dpNew,
    `${pool.id}: admitAndRank must match the FVDP-new order`)
  assert.deepEqual(admitAndRank(options).results.map((r) => r.evidenceId),
    admitAndRank({ ...options, dedupe: false }).results.map((r) => r.evidenceId),
    `${pool.id}: folding must be OFF by default`)
  assert.deepEqual(admitAndRank({ ...options, dedupe: true }).results.map((r) => r.evidenceId),
    fold(pool, run.dpNew.map((id) => ({ id }))).kept.map((x) => x.id),
    `${pool.id}: admitAndRank dedupe must match greedy folding`)
}

console.log('\nok: N_off value-only ablation on the frozen fixture (in-sample, example params, label-derived metrics) — components isolated incl. D/P separately; folding opt-in; no scope gate and no rescue read exist; see the printed limits for what this does NOT establish')
