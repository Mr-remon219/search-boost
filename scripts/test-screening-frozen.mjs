import './isolate-tests.mjs'
// T03: the N_off migration must not move the prototype numbers or ordering.
// Expectations in scripts/screening-core-frozen.json were captured from the
// 0a0ce082 prototype controller BEFORE this change, with the same projection
// functions; regenerating them from the new implementation would defeat the test.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildSnapshot, admitAndRank } from '../lib/search/screening/controller.js'
import { screeningScore, DEFAULT_SCREENING_PARAMS } from '../lib/search/screening/scoring.js'
import { foldsInto, docStem, versionMajor } from '../lib/search/screening/duplicates.js'
import { POOLS } from './screening-ablation-fixture.mjs'
import {
  rankingInput, projectScoring, projectSnapshot, projectAdmit, FROZEN_SCORING_CASES,
  FROZEN_SNAPSHOT_CASES, FROZEN_RANKING_CASES, FROZEN_BASE_COMMIT,
} from './screening-core-fixture.mjs'

const frozen = JSON.parse(readFileSync(new URL('./screening-core-frozen.json', import.meta.url), 'utf8'))
assert.equal(frozen.baseCommit, FROZEN_BASE_COMMIT)
assert.equal(frozen.note.includes('before the N_off migration'), true)

// The frozen defaults are the design's initial values, not calibrated numbers.
assert.deepEqual(frozen.prototypeParams, JSON.parse(JSON.stringify(DEFAULT_SCREENING_PARAMS)))

// ---- scoring: identical numeric outputs for identical inputs ----
assert.equal(frozen.scoring.length, FROZEN_SCORING_CASES.length)
for (const [index, entry] of frozen.scoring.entries()) {
  assert.deepEqual(entry.input, FROZEN_SCORING_CASES[index])
  assert.deepEqual(projectScoring(screeningScore(entry.input)), entry.output, `scoring case ${index}`)
}

// ---- snapshot: identical rows, order, provenance and text ----
assert.equal(frozen.snapshot.length, FROZEN_SNAPSHOT_CASES.length)
for (const [index, entry] of frozen.snapshot.entries()) {
  assert.equal(entry.name, FROZEN_SNAPSHOT_CASES[index].name)
  const rows = buildSnapshot(entry.rows, entry.engineWeights ? { engineWeights: entry.engineWeights } : {})
  assert.deepEqual(projectSnapshot(rows), entry.output, `snapshot case ${entry.name}`)
}

// ---- admission/ranking: identical fields, order, counts and stop reason ----
assert.equal(frozen.rankings.length, FROZEN_RANKING_CASES.length)
for (const [index, entry] of frozen.rankings.entries()) {
  assert.equal(entry.name, FROZEN_RANKING_CASES[index].name)
  const artifact = admitAndRank(rankingInput(entry))
  assert.deepEqual(projectAdmit(artifact), entry.output, `ranking case ${entry.name}`)
}

// ---- invariants the frozen comparison alone cannot state ----
{
  // mu=0 is the default and near-duplicate folding is off: the shipped flow must
  // not silently enable either.
  assert.equal(DEFAULT_SCREENING_PARAMS.mu, 0)
  const [plain] = frozen.rankings
  assert.deepEqual(plain.output.results.map((row) => row.id), plain.output.results.map((_, index) => `r${index + 1}`))
  assert.equal(plain.output.diagnostics.duplicatesFolded, 0)
  // D=1 for the default policy unless the material has real provenance; missing
  // provenance selects `unknown` and stays neutral.
  const noProvenance = projectAdmit(admitAndRank(rankingInput({
    ...FROZEN_RANKING_CASES[0],
    judgements: [['m1', { ...FROZEN_RANKING_CASES[0].judgements[0][1], discount: { state: 'selected', option: 'unknown', codeSelected: true, selectedBy: 'code' } }]],
  })))
  assert.deepEqual(noProvenance.results.map((row) => row.sourceDiscountFactor), [1])
  // confidence is recorded, never scored: only the signal field moves
  const confident = (valueConfidence) => projectAdmit(admitAndRank({
    candidates: [FROZEN_RANKING_CASES[0].candidates[0]],
    judgements: new Map([['m1', { ...FROZEN_RANKING_CASES[0].judgements[0][1], valueConfidence }]]),
    maxResults: 8,
  }))
  assert.equal(confident(.01).results[0].finalScore, confident(.99).results[0].finalScore)
  assert.equal(confident(.01).results[0].signals.valueConfidence, .01)
  assert.equal(confident(.99).results[0].signals.valueConfidence, .99)
}
{
  // duplicates.js is untouched: the frozen ablation fixture still folds the
  // same-cluster mirrors and still keeps explicit different major versions apart.
  const folded = POOLS.flatMap((pool) => pool.candidates)
  const clusters = new Map()
  for (const item of folded) {
    const stem = docStem(item.url)
    const major = versionMajor(item.url, item.title)
    const candidates = clusters.get(stem) ?? []
    candidates.push({ item, major })
    clusters.set(stem, candidates)
  }
  for (const [stem, candidates] of clusters) {
    if (!stem || candidates.length < 2) continue
    for (const left of candidates) for (const right of candidates) {
      if (left === right) continue
      if (left.major !== null && right.major !== null && left.major !== right.major) {
        assert.equal(foldsInto(left.item, right.item), false, `${left.item.id} must not fold into ${right.item.id}`)
      }
    }
  }
}

console.log('ok: frozen prototype numbers, order, provenance and stop reasons are unchanged by the N_off migration (T03)')
