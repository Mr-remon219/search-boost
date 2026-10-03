#!/usr/bin/env node
import './isolate-tests.mjs'
// Frozen exact ordinary fused replays. Two independent expectation sets:
//   fused-baseline-v1.json          captured from checkout 77e01146271f4d718cc6d8ce499978f94a517203
//   fused-baseline-community-v1.json captured from the N_off worktree base
//                                   0a0ce082c3c287e56a72400a599736b242c829e9 BEFORE the snapshot changes
// Matching both proves the merged base behaves identically to the reference checkout for
// ordinary fused, and that the N_off snapshot/community work never moved ordinary scores,
// final lists, selectionScore or provenance. Expected digests are never regenerated here.
// Two community=true cases carry a DECLARED beta.6 public-output-contract migration: their
// digestProvenance records the original digest and the exact public-field removals, so the
// digest still pins scores/list/selectionScore/provenance but is not pre-change row identity.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFused, runXSearch, invalidateSearchCaches } from '../lib/runtime.mjs'
import {
  FUSED_BASELINE_SHA,
  NOFF_BASE_SHA,
  baselineSnapshot,
  baselineOfficialSearch,
  baselineFallbackSearch,
  fusedBaselineDigest,
} from './fused-baseline-fixture.mjs'

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'))
const ordinary = read('./fused-baseline-v1.json')
const community = read('./fused-baseline-community-v1.json')
assert.equal(ordinary.baseline, FUSED_BASELINE_SHA)
assert.equal(community.baseline, NOFF_BASE_SHA)

const selectedSummary = (result) => result.results.map((row) => ({
  url: row.url, score: row.score, selectionScore: row.selectionScore ?? null,
  engines: row.engines, username: row.username ?? null,
}))

for (const { args, digest, selected } of ordinary.cases) {
  invalidateSearchCaches()
  const result = await runFused(args, { snapshot: baselineSnapshot })
  assert.equal(fusedBaselineDigest(result), digest, `${args.ranking}/${args.enginePool}: ordinary fused score/list/provenance changed`)
  assert.deepEqual(result.results.map((r) => ({ url: r.url, score: r.score, selectionScore: r.selectionScore })), selected)
}

const state = baselineSnapshot({ xOfficial: true })
const xSearch = (args, opts) => runXSearch(args, {
  ...opts, snapshot: () => state,
  officialSearch: baselineOfficialSearch,
  fallbackSearch: baselineFallbackSearch,
})

for (const { args, digest, selected, communityUsed, digestProvenance } of community.cases) {
  invalidateSearchCaches()
  const result = await runFused(args, { snapshot: () => state, xSearch })
  const basis = digestProvenance
    ? `[declared ${digestProvenance.migration}; scores/list/selectionScore/provenance must be identical]`
    : '[frozen pre-change identity]'
  assert.equal(fusedBaselineDigest(result), digest, `${args.ranking}/${args.enginePool} community=${args.community}: ordinary fused scores, list, selectionScore or public fields changed ${basis}`)
  assert.deepEqual(selectedSummary(result), selected)
  assert.equal(result.communityUsed, communityUsed)
}

console.log(`ok: ${ordinary.cases.length} frozen ordinary fused replays (${FUSED_BASELINE_SHA.slice(0, 7)}) and ${community.cases.length} community on/off replays (${NOFF_BASE_SHA.slice(0, 7)}) match baseline scores, final lists, selectionScore and provenance; ${community.cases.filter((c) => c.digestProvenance).length} community=true cases also pin the declared beta.6 public field projection`)
