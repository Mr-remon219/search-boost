import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { POOLS, PREFERENCE_MATCH_VALUE } from './screening-ablation-fixture.mjs'
import { admitAndRank, runScreening } from '../lib/search/screening/controller.js'
import { decodeScreening } from '../lib/search/screening/judgments.js'
import { screeningScore, DEFAULT_SCREENING_PARAMS } from '../lib/search/screening/scoring.js'
import { foldsInto, docStem } from '../lib/search/screening/duplicates.js'
import { eligibleDiscountOptions, validateSourceBiasPolicy } from '../lib/search/screening/policy.js'

// ============================================================================
// Frozen-label ablation for the fused+Jev screening prototype.
//
// Method: every candidate carries two label layers — `tool` (excerpt-level
// screening judgement) and `gold` (provisional development reference labels). Variants
// add ONE component at a time while candidates, labels and admission inputs stay
// fixed: F → FH (hard constraints) → FHV (value admission) → re-rank (new vs
// old formula) → +D / +P separately (FHV+D, FHV+P) → +D+P → near-duplicate fold.
// Rescue uses the real runScreening controller with simulated reads/answers.
// No live network/Jev calls or independently validated labels are claimed.
//
// HONEST LIMITS (printed at the end): metrics are computed from the gold value
// field that re-ranking also consumes, so "new ≥ old" is largely label-derived;
// the shipped params are the design doc's EXAMPLE values, not calibrated; every
// same-cluster pair shares a URL stem, so fold recall is in-sample and cross-slug
// mirror misses are unmeasured; D and P are reported per-pool because this
// fixture may not move any rank for them. Folding is opt-in (dedupe=false
// default) — the run proves the mechanism, not a default.
// ============================================================================

const K = 5
const EPSILON = 0.1

// Declared test policy — policy_preference only, NOT a validated quality claim:
// for documentation questions, generic web-search channels merit a discount.
const GENERIC_WEB_POLICY = validateSourceBiasPolicy({
  version: 'ablation-generic-web-v1',
  nature: 'policy_preference',
  mildEligible: ['bing', 'ddg', 'yahoo', 'exa-free', 'anysearch'],
  strongEligible: ['bing', 'ddg', 'yahoo'],
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
  const gain = (id) => (gold(id).scope === 'pass' ? gold(id).value : 0)
  const dcg = top.reduce((sum, id, i) => sum + gain(id) / Math.log2(i + 2), 0)
  const ideal = [...pool.candidates].map((c) => gain(c.id)).sort((a, b) => b - a).slice(0, K)
  const idcg = ideal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  // Document-level nDCG: each underlying document counts its value once, so URL
  // mirrors of one page cannot inflate the score (the artifact that makes plain
  // nDCG prefer mirror stacking).
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
  const firstKey = top.findIndex((id) => { const g = gold(id); return g.scope === 'pass' && g.value >= 4 })
  return {
    returned: orderedIds.length,
    useful: top.filter((id) => { const g = gold(id); return g.scope === 'pass' && g.value >= 3 }).length,
    key: top.filter((id) => { const g = gold(id); return g.scope === 'pass' && g.value >= 4 }).length,
    firstKey: firstKey < 0 ? null : firstKey + 1,
    ndcg: idcg ? dcg / idcg : 1,
    docNdcg: dIdcg ? dDcg / dIdcg : 1,
    misadmit: top.filter((id) => gold(id).scope === 'fail').length,
    undecidable: top.filter((id) => gold(id).scope === 'unestablished').length,
    distinct: new Set(top.map((id) => clusterOf(pool, id))).size,
    poolUseful: pool.candidates.filter((c) => c.gold.scope === 'pass' && c.gold.value >= 3).length,
  }
}

const fmt = (m) => `useful@${K}=${m.useful} key@${K}=${m.key} firstKey=${m.firstKey ?? '—'} ndcg=${m.ndcg.toFixed(3)} docNdcg=${m.docNdcg.toFixed(3)} misadmit=${m.misadmit} undec=${m.undecidable} distinct@${K}=${m.distinct} n=${m.returned} recall=${m.poolUseful ? (m.useful / m.poolUseful).toFixed(2) : '—'}`

async function runPool(pool, rescued, rescueOptions = {}) {
  const candidates = pool.candidates.map((c) => ({
    evidenceId: c.id, key: c.url, url: c.url, title: c.title, text: c.text,
    basis: 'engine_snippet', baseScore: c.B, engines: c.engines, safetyState: 'clear',
  }))
  const byId = new Map(pool.candidates.map((c) => [c.id, c]))
  const decoded = new Map()
  const reads = []
  const judgedIds = []
  const controller = await runScreening({
    candidates, question: pool.question, intent: pool.intent,
    constraints: pool.constraints, preferences: pool.preferences,
    policy: GENERIC_WEB_POLICY, maxResults: 20, dedupe: false,
    rescue: { maxReads: rescued ? pool.candidates.length : 0, ...rescueOptions },
    rescueRead: async (candidate) => {
      reads.push(candidate.evidenceId)
      const c = byId.get(candidate.evidenceId)
      if (!c.rescue || c.rescue.status === 'read_failed') return null
      // This is a simulation marker + fixture note, NOT an archived full page.
      return { text: `Simulated reread: ${c.rescue.note}`, basis: 'simulated_rescue', textVersion: 'simulation-v1', safetyState: 'clear' }
    },
    judge: async (request) => {
      const labels = new Map(request.state.candidates.map((ref) => {
        const c = byId.get(ref.id)
        const fragment = request.state.sources[ref.source_index].fragments[ref.fragment_index]
        judgedIds.push(ref.id)
        return [ref.id, fragment.text_basis === 'simulated_rescue' ? c.rescue : c.tool]
      }))
      const entries = new Map(request.mapping.filter((m) => Object.hasOwn(request.questions, m.id)).map((m) => {
        const l = labels.get(m.candidateId)
        const c = byId.get(m.candidateId)
        if (m.kind === 'scope') return [m.id, { type: 'noul', value: l.scope === 'pass' ? .99 : .1 }]
        const option = m.kind === 'info' ? l.info : m.kind === 'value' ? String(l.value)
          : m.kind === 'discount' ? discountOption(c, GENERIC_WEB_POLICY) : l.pref
        return [m.id, { type: 'choice', choice: option }]
      }))
      for (const [id, judgement] of decodeScreening(entries, request.mapping)) decoded.set(id, judgement)
      return entries
    },
  })
  const label = (c) => {
    const j = decoded.get(c.id)
    return { scope: j.scope.state, info: j.info, value: j.value.state === 'level' ? j.value.level : j.value.state, pref: j.preferences[0] }
  }
  const admitted = pool.candidates.filter((c) => {
    const l = label(c)
    return l.scope === 'pass' && typeof l.value === 'number' && l.value >= 3
  })
  const rank = (scoreOf, options = {}) => admitted
    .map((c) => ({ id: c.id, score: scoreOf(c, label(c), options) }))
    .sort(byScoreThenId).map((x) => x.id)
  const rankB = pool.candidates.map((c) => ({ id: c.id, score: c.B })).sort(byScoreThenId).map((x) => x.id)
  const rankFH = pool.candidates.filter((c) => label(c).scope === 'pass')
    .map((c) => ({ id: c.id, score: c.B })).sort(byScoreThenId).map((x) => x.id)
  const rankAdmittedB = admitted.map((c) => ({ id: c.id, score: c.B })).sort(byScoreThenId).map((x) => x.id)
  const discountOf = (c) => discountOption(c, GENERIC_WEB_POLICY)

  // Component rows stay separate so D and P are not silently bundled, and the
  // fold is applied to BOTH old and new orders so its effect is not attributed
  // to the formula.
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
    label, admitted, dpNew, dpOld, dpNewPlain, dpOldPlain, dpNewD, dpNewP, controller, reads, judgedIds,
    rows: [
      ['F            fused B order      ', rankB],
      ['FH           +constraints       ', rankFH],
      ['FHV          admitted, B order  ', rankAdmittedB],
      ['FHV-old      re-rank old formula', dpOldPlain],
      ['FHV-new      re-rank new formula', dpNewPlain],
      ['FHV-old+D    discount only(old) ', dpOldD],
      ['FHV-new+D    discount only(new) ', dpNewD],
      ['FHV-old+P    preference only(old)', dpOldP],
      ['FHV-new+P    preference only(new)', dpNewP],
      ['FHVDP-old    +D+P old formula   ', dpOld],
      ['FHVDP-new    +D+P new formula   ', dpNew],
      ['FHVDP-old+fold  near-dup fold   ', foldedOld.kept.map((x) => x.id)],
      ['FHVDP-new+fold  near-dup fold   ', foldedNew.kept.map((x) => x.id)],
    ],
    collapsed: foldedNew.collapsed,
    collapsedOld: foldedOld.collapsed,
  }
}

// ------------------------------------------------------------------ report --
const results = {}
for (const pool of POOLS) {
  const excludedHighValue = pool.candidates.filter((c) => c.gold.scope === 'fail' && c.gold.value >= 4).length
  const excludedUndecided = pool.candidates.filter((c) => c.gold.scope === 'unestablished' && c.gold.value >= 4).length
  const snippetMiss = pool.candidates.filter((c) => {
    const t = c.tool
    return c.gold.scope === 'pass' && c.gold.value >= 3 && !(t.scope === 'pass' && typeof t.value === 'number' && t.value >= 3)
  }).map((c) => c.id)
  console.log(`\n=== pool ${pool.id}: ${pool.question} ===`)
  console.log(`pool stats: candidates=${pool.candidates.length} excluded-high-value=${excludedHighValue} excluded-undecided-high-value=${excludedUndecided} snippet-insufficiency-miss=[${snippetMiss.join(',')}]`)
  for (const rescued of [false, true]) {
    const run = await runPool(pool, rescued)
    console.log(`-- ${rescued ? 'rescue ON ' : 'rescue OFF'} --`)
    console.log(`  simulated controller: reads=${run.reads.length} failures=${run.controller.diagnostics.rescueReadFailed} scopeRecovered=${run.controller.diagnostics.rescueScopeRecovered} admittedRecovered=${run.controller.diagnostics.rescueRecovered} judgeCalls=${run.controller.diagnostics.judgeCalls}; network/Jev costs NOT measured`)
    assert.deepEqual(run.controller.results.map((r) => r.evidenceId), run.dpNew, 'real controller must reproduce replay admission/ranking')
    if (pool.id === 'A') {
      // A3 passes the constraints and its value is unestablished, so the initial
      // scope-only rescue never targets it; the opt-in trial below may try, and
      // its fixture read fails — neither may invent a second judgement.
      assert.ok(!run.reads.includes('A3'), 'scope-only rescue never targets a scope-pass candidate')
      assert.equal(run.judgedIds.filter((id) => id === 'A3').length, 1)
      assert.equal(run.label(pool.candidates.find((c) => c.id === 'A3')).value, 'unestablished', 'failed read must not invent a level')
    }
    for (const [name, ids] of run.rows) console.log(`  ${name}  ${fmt(metrics(pool, ids))}`)
    if (run.collapsed.length) console.log(`  folded: ${run.collapsed.map((d) => `${d.id}→${d.into}`).join(' ')}`)
    results[`${pool.id}:${rescued}`] = run
  }
  const off = results[`${pool.id}:false`]
  const dEffect = off.dpNewPlain.join() !== off.dpNewD.join()
  const pEffect = off.dpNewPlain.join() !== off.dpNewP.join()
  console.log(`  D-only ${dEffect ? 'changes the order' : 'no measurable rank effect'}; P-only ${pEffect ? 'changes the order' : 'no measurable rank effect'} (rescue OFF)`)
}

// ------------------------ opt-in rescue extension (trial, not a baseline) --
// The frozen rows above use the initial scope-only rescue. This third variant
// additionally lets a scope-established candidate whose reading value is still
// unestablished be reread once (`rescue.valueUnknown`). It carries its own
// counters and is reported as an experiment: metrics stay label-derived and
// in-sample, so it shows what the mechanism does, never that it improves quality.
for (const pool of POOLS) {
  const baseline = results[`${pool.id}:true`]
  const extended = await runPool(pool, true, { valueUnknown: true })
  const counters = (run) => `reads=${run.reads.length} attempted=${run.controller.diagnostics.rescueAttempted} scopeRecovered=${run.controller.diagnostics.rescueScopeRecovered} valueRecovered=${run.controller.diagnostics.rescueValueRecovered} readFailed=${run.controller.diagnostics.rescueReadFailed} admittedRecovered=${run.controller.diagnostics.rescueRecovered}`
  console.log(`\nvalue-unknown rescue trial — pool ${pool.id} (opt-in; label-derived, in-sample):`)
  console.log(`  scope-only    ${counters(baseline)}`)
  console.log(`  +valueUnknown ${counters(extended)}`)
  console.log(`  delivered  scope-only [${baseline.controller.results.map((r) => r.evidenceId).join(',')}] → +valueUnknown [${extended.controller.results.map((r) => r.evidenceId).join(',')}]`)
  console.log(`  metrics     scope-only    ${fmt(metrics(pool, baseline.dpNew))}`)
  console.log(`  metrics     +valueUnknown ${fmt(metrics(pool, extended.dpNew))}`)
  for (const id of extended.reads) assert.equal(extended.reads.filter((other) => other === id).length, 1, 'a candidate is reread at most once')
  const byId = new Map(pool.candidates.map((c) => [c.id, c]))
  const plan = extended.controller.run.rescuePlan
  // Non-vacuous ordering check: the plan follows non-increasing fused base score.
  for (const [index, id] of plan.entries()) {
    if (index > 0) assert.ok(byId.get(plan[index - 1]).B >= byId.get(id).B, 'rescue plan must follow non-increasing base score')
  }
  assert.ok(extended.reads.length >= baseline.reads.length, 'the opt-in extension can only add rescue attempts')
  if (pool.id === 'A') {
    // The extension really reaches a scope-pass, value-unknown candidate, and its
    // failing fixture read must not fabricate a judgement or a level.
    assert.ok(extended.reads.includes('A3'), 'the opt-in extension reaches A3')
    assert.ok(extended.controller.diagnostics.rescueReadFailed >= 1, 'the A3 read failure is counted')
    assert.equal(extended.judgedIds.filter((id) => id === 'A3').length, 1)
    assert.equal(extended.label(pool.candidates.find((c) => c.id === 'A3')).value, 'unestablished')
  }
}

// -------------------------------------------------------- parameter context --
// The shipped values are the design doc's EXAMPLE parameters, never calibrated
// against the recorded B range. Print what they imply so the degeneracy is
// visible instead of hidden behind a table.
{
  const { tau, lambda, utilities: u } = DEFAULT_SCREENING_PARAMS
  const allB = POOLS.flatMap((p) => p.candidates.map((c) => c.B)).sort((a, b) => a - b)
  const bOf = (B) => B / (B + tau)
  const minB = allB[0]
  const maxB = allB[allB.length - 1]
  const maxGap = bOf(maxB) - bOf(minB)
  const lambdaLimit = (du) => du / (du + maxGap)
  console.log(`\nparameter context (tau=${tau}, lambda=${lambda}, u=example values, NOT calibrated):`)
  console.log(`  recorded B ${minB.toFixed(4)}..${maxB.toFixed(4)} → b ${bOf(minB).toFixed(4)}..${bOf(maxB).toFixed(4)}; any recorded base gap Δb ≤ ${maxGap.toFixed(4)}`)
  console.log(`  a one-level value gap beats ANY recorded base gap when lambda < Δu/(Δu+Δb): u3→4=${lambdaLimit(u['4'] - u['3']).toFixed(3)} u4→5=${lambdaLimit(u['5'] - u['4']).toFixed(3)} u3→5=${lambdaLimit(u['5'] - u['3']).toFixed(3)}; current lambda=${lambda}`)
}

// -------------------------------------------------------------- label audit --
{
  const admitted = POOLS.flatMap((p) => p.candidates.filter((c) => c.tool.scope === 'pass' && typeof c.tool.value === 'number' && c.tool.value >= 3))
  const agree = admitted.filter((c) => c.tool.value === c.gold.value).length
  const falsePositive = POOLS.flatMap((p) => p.candidates.filter((c) => c.tool.scope === 'pass' && c.gold.scope === 'fail').map((c) => c.id))
  console.log(`\nlabel audit: admitted tool=gold value agreement ${agree}/${admitted.length}; tool-pass/gold-fail=[${falsePositive.join(',')}] (${falsePositive.length ? 'false-positive axis present' : 'false-positive axis UNMEASURED in this fixture'})`)
  console.log('  → rankings consume the same value field the metric gain uses: "new ≥ old" is label-derived, not an independent quality result')
}

// ----------------------------------------------- documented ablation traps --
// Value re-ranking WITHOUT folding concentrates mirrors of one document in the
// first screen (pool C: four copies of the same manual). Folding must strictly
// improve distinct-document coverage there.
{
  const run = results['C:false']
  const noFold = metrics(POOLS[2], run.dpNew)
  const withFold = metrics(POOLS[2], fold(POOLS[2], run.dpNew.map((id) => ({ id }))).kept.map((x) => x.id))
  const oldFold = metrics(POOLS[2], fold(POOLS[2], run.dpOld.map((id) => ({ id }))).kept.map((x) => x.id))
  console.log(`\npool C mirror stacking: unfolder distinct@${K}=${noFold.distinct} docNdcg=${noFold.docNdcg.toFixed(3)} → folded distinct@${K}=${withFold.distinct} docNdcg=${withFold.docNdcg.toFixed(3)}`)
  console.log(`  attribution: the OLD order folded gives distinct@${K}=${oldFold.distinct} docNdcg=${oldFold.docNdcg.toFixed(3)} too — this pool's diversity gain is a fold effect`)
  for (const [tag, newer, older] of [['FHV (no D/P)', run.dpNewPlain, run.dpOldPlain], ['FHVDP', run.dpNew, run.dpOld]]) {
    const a = metrics(POOLS[2], newer).docNdcg, b = metrics(POOLS[2], older).docNdcg
    const relation = Math.abs(a - b) < 1e-12 ? '=' : a < b ? '<' : '>'
    console.log(`  ${tag} docNdcg: new ${a.toFixed(3)} ${relation} old ${b.toFixed(3)}; delta=${(a - b).toFixed(6)}`)
  }
  assert.ok(withFold.distinct > noFold.distinct, 'folding must improve first-screen document diversity')
  assert.ok(withFold.docNdcg >= noFold.docNdcg - 1e-12, 'folding must not lose document-level nDCG')
  assert.equal(oldFold.distinct, withFold.distinct, 'fold effect must not be attributed to the formula')
  assert.ok(noFold.distinct <= 2, 'documented finding: un-deduped re-rank stacks one document')
}

// -------------------------------------- near-duplicate folding correctness --
// foldsInto must agree with gold document identity, including the traps: two
// different `duckdb-vs-sqlite` articles sharing a URL basename (A1/A2), MDN vs
// Node.js AbortSignal pages with similar titles (B3/B5), two patch snapshots of
// one manual (B9/B10 fold), a third-party page quoting the man page verbatim
// (C8 must NOT fold into C1 despite identical text), and a versioned docs path
// (C9 must fold into C1).
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
  assert.equal(folded, left.cluster === right.cluster, `${poolId}:${a}/${b} folding must match gold document identity`)
}
assert.equal(docStem('https://git-scm.com/docs/git-sparse-checkout/2.55.0'),
  docStem('https://git-scm.com/docs/git-sparse-checkout'),
  'versioned docs path must share the canonical document stem')
console.log(`fold checks: ${foldChecks.length} pairs PASS — but IN-SAMPLE (thresholds chosen on these same pairs; every same-cluster pair shares a docStem, so cross-slug mirror misses are unmeasured); folding stays opt-in`)

// ------------------------------------------------------------- invariants --
for (const pool of POOLS) {
  const off = results[`${pool.id}:false`]
  const on = results[`${pool.id}:true`]
  for (const [name, ids] of off.rows) {
    const m = metrics(pool, ids)
    // VACUOUS IN THIS FIXTURE: both gold-fail items (A9, B7) are declared tool
    // not_passed, so no variant can admit them and this assertion cannot fail.
    // The false-positive axis is reported as UNMEASURED in the label audit above;
    // exercising it needs a tool-pass/gold-fail pair, which this fixture lacks.
    if (!name.startsWith('F ') && !name.startsWith('FH ')) assert.equal(m.misadmit, 0, `${pool.id}/${name}: no gold-fail material may be published`)
  }
  const pick = (run, tag) => metrics(pool, run.rows.find(([n]) => n.includes(tag))[1])
  const oldF = pick(off, 'FHV-old'), newF = pick(off, 'FHV-new')
  assert.ok(newF.ndcg >= oldF.ndcg - 1e-12, `${pool.id}: new formula nDCG must not lose to old`)
  assert.ok((newF.firstKey ?? 99) <= (oldF.firstKey ?? 99), `${pool.id}: new formula must not rank key evidence later`)
  const oldDP = metrics(pool, off.dpOld), newDP = metrics(pool, off.dpNew)
  assert.ok(newDP.ndcg >= oldDP.ndcg - 1e-12, `${pool.id}: new+D+P nDCG must not lose to old+D+P`)
  for (const [name] of off.rows) {
    const a = metrics(pool, off.rows.find(([n]) => n === name)[1])
    const b = metrics(pool, on.rows.find(([n]) => n === name)[1])
    assert.ok(b.useful >= a.useful, `${pool.id}/${name}: rescue must not reduce useful@${K}`)
    assert.ok(b.misadmit <= a.misadmit, `${pool.id}/${name}: rescue must not increase misadmits`)
  }
}

// --------------------------------------------------- production cross-check --
// admitAndRank must reproduce this runner's FHVDP-new order on identical input,
// and its dedupe option must reproduce greedy near-duplicate folding.
for (const pool of POOLS) {
  for (const rescued of [false, true]) {
    const run = results[`${pool.id}:${rescued}`]
    const candidates = pool.candidates.map((c) => ({
      evidenceId: c.id, key: c.url, url: c.url, title: c.title, text: c.text,
      baseScore: c.B, engines: c.engines, safetyState: 'clear',
    }))
    const judgements = new Map(pool.candidates.map((c) => {
      const l = run.label(c)
      return [c.id, {
        scope: { state: l.scope }, info: l.info ?? null,
        value: typeof l.value === 'number' ? { state: 'level', level: l.value } : { state: l.value },
        discount: { state: 'selected', option: discountOption(c, GENERIC_WEB_POLICY) },
        preferences: [l.pref],
      }]
    }))
    const options = { candidates, judgements, constraints: pool.constraints, preferences: pool.preferences, policy: GENERIC_WEB_POLICY, maxResults: 20 }
    assert.deepEqual(admitAndRank({ ...options, dedupe: false }).results.map((r) => r.evidenceId), run.dpNew,
      `${pool.id}/${rescued}: admitAndRank must match FHVDP-new order`)
    assert.deepEqual(admitAndRank(options).results.map((r) => r.evidenceId),
      admitAndRank({ ...options, dedupe: false }).results.map((r) => r.evidenceId),
      `${pool.id}/${rescued}: folding must be OFF by default`)
    assert.deepEqual(admitAndRank({ ...options, dedupe: true }).results.map((r) => r.evidenceId),
      fold(pool, run.dpNew.map((id) => ({ id }))).kept.map((x) => x.id),
      `${pool.id}/${rescued}: admitAndRank dedupe must match greedy folding`)
  }
}

console.log('\nok: frozen-label ablation (in-sample, example params, label-derived metrics) — components isolated incl. D/P separately; folding and the value-unknown rescue are mechanism tests, opt-in only; see the printed limits for what this does NOT establish')
