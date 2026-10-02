// Deterministic prototype inputs for the frozen numeric/order contract (T03).
//
// The expectations live in scripts/screening-core-frozen.json and were captured
// from the 0a0ce082 prototype controller BEFORE the N_off migration changed it,
// with the exact same inputs and the exact same projection function below. The
// N_off admission change must keep the prototype scoring.math rows, the
// snapshot order and every numeric/finalScore/selection field identical; the
// retired scope/info fields are intentionally NOT part of the projection.
export const FROZEN_BASE_COMMIT = '0a0ce082c3c287e56a72400a599736b242c829e9'

export const FROZEN_SCORING_CASES = [
  { baseScore: 1, valueLevel: 3, discount: 'none', preferenceMatches: [] },
  { baseScore: .5, valueLevel: 5, discount: 'none', preferenceMatches: [] },
  { baseScore: .1, valueLevel: 5, discount: 'none', preferenceMatches: [] },
  { baseScore: 1, valueLevel: 5, discount: 'strong', preferenceMatches: [] },
  { baseScore: 1, valueLevel: 4, discount: 'none', preferenceMatches: ['match', 'match'] },
  { baseScore: .7, valueLevel: 4, discount: 'mild', preferenceMatches: ['match', 'partial'] },
  { baseScore: 2.1822855040571345, valueLevel: 5, discount: 'unknown', preferenceMatches: ['match', 'unknown', 'no_match'] },
  { baseScore: 100, valueLevel: 3, discount: 'none', preferenceMatches: [] },
  { baseScore: .01, valueLevel: 5, discount: 'none', preferenceMatches: [] },
]

// Snapshot rows: URL duplicates, a zero-weight engine, a pending/unverified
// sibling and equal-score ordering. Texts stay far below the 8000-character
// excerpt cap so the frozen expectation is independent of the cap value.
export const FROZEN_SNAPSHOT_CASES = [
  {
    name: 'duplicate-observation-worst-safety',
    rows: [
      { url: 'https://dup.example/page', title: 'Duplicate page', score: 1, snippet: 'short snippet', safetyState: 'clear', textVersion: 'v1', engineRanks: { bing: 1 }, provenance: [] },
      { url: 'https://dup.example/page', title: 'Duplicate page', score: .5, content: 'a much longer page body from the same URL', safetyState: 'violation', textVersion: 'v2', engineRanks: { exa: 1 }, provenance: [{ engine: 'exa', rank: 1 }] },
    ],
  },
  {
    name: 'zero-weight-engine-provenance',
    rows: [{ url: 'https://weights.example/a', title: 'Weights', score: 1.1, snippet: 'weighted snippet', engineRanks: { bing: 1, exa: 1 }, provenance: [{ engine: 'bing', rank: 1 }, { engine: 'exa', rank: 1 }] }],
    engineWeights: { bing: 1, exa: 0 },
  },
  {
    name: 'score-tie-key-order',
    rows: [
      { url: 'https://tie.example/b', title: 'B', score: 1.5, snippet: 'text b', engineRanks: { bing: 2 }, provenance: [] },
      { url: 'https://tie.example/a', title: 'A', score: 1.5, snippet: 'text a', engineRanks: { bing: 1 }, provenance: [] },
      { url: 'https://tie.example/c', title: 'C', score: .4, snippet: 'text c', engineRanks: { bing: 3 }, provenance: [] },
    ],
  },
]

const judgement = (level, over = {}) => ({
  scope: { state: 'skipped' }, info: null,
  value: { state: 'level', level }, valueConfidence: .8,
  discount: { state: 'selected', option: 'none', selectedBy: 'code' }, discountConfidence: .5,
  preferences: [], preferenceConfidences: [], ...over,
})

const candidate = (id, over = {}) => ({
  evidenceId: id, key: `key-${id}`, url: `https://${id}.example/doc`, title: `Document ${id}`,
  text: `Reading material body for ${id} with enough words to compare`, baseScore: 1,
  safetyState: 'clear', engines: ['bing'], engineRanks: { bing: 1 }, provenance: [], ...over,
})

export const FROZEN_RANKING_CASES = [
  {
    name: 'plain-ranking-with-discounts-preferences-and-ties',
    candidates: [
      candidate('m1', { baseScore: 1 }),
      candidate('m2', { baseScore: .5 }),
      candidate('m3', { baseScore: .5 }),
      candidate('m4', { baseScore: .9 }),
      candidate('m5', { baseScore: .2 }),
    ],
    judgements: [
      ['m1', judgement(5, { preferences: ['match', 'partial'] })],
      ['m2', judgement(4, { discount: { state: 'selected', option: 'mild', selectedBy: 'model' }, preferences: ['partial', 'no_match'] })],
      ['m3', judgement(4, { discount: { state: 'selected', option: 'strong', selectedBy: 'code' }, preferences: ['unknown', 'match'] })],
      ['m4', judgement(3, { discount: { state: 'selected', option: 'unknown', selectedBy: 'code' } })],
      ['m5', judgement(5)],
    ],
    preferences: ['Prefer implementation details', 'Prefer traceable references'],
    maxResults: 10,
  },
  {
    name: 'truncation-keeps-ranking-order',
    candidates: [candidate('m1', { baseScore: 1 }), candidate('m2', { baseScore: .5 }), candidate('m3', { baseScore: .9 }), candidate('m4', { baseScore: .2 })],
    judgements: [['m1', judgement(3)], ['m2', judgement(5)], ['m3', judgement(4)], ['m4', judgement(5)]],
    maxResults: 2,
  },
  {
    name: 'soft-redundancy-mu-keeps-finalScore-immutable',
    candidates: [
      candidate('m1', { baseScore: 1, title: 'SQLite concurrent writers', text: 'Concurrent writes to one SQLite database file from two processes require a busy timeout and careful transaction scope to avoid lock errors' }),
      candidate('m2', { baseScore: .9, title: 'SQLite concurrent writers mirror', text: 'Concurrent writes to one SQLite database file from two processes require a busy timeout and careful transaction scope to avoid lock errors' }),
      candidate('m3', { baseScore: .8, title: 'Git sparse-checkout cone mode', text: 'The cone mode of git sparse-checkout restricts the working tree to a directory and its parents which is faster than pattern matching' }),
    ],
    judgements: [['m1', judgement(5)], ['m2', judgement(5)], ['m3', judgement(5)]],
    maxResults: 3,
    mu: .8,
  },
  {
    name: 'pending-candidate-is-not-admitted',
    candidates: [candidate('m1', { baseScore: 1 }), candidate('m2', { baseScore: .9 })],
    judgements: [['m1', judgement(4)]],
    maxResults: 8,
  },
  {
    name: 'unassessable-candidate-keeps-disclosed-reason',
    candidates: [candidate('m1', { baseScore: 1 }), candidate('m2', { baseScore: .9 })],
    judgements: [['m1', judgement(5)]],
    unassessable: { m2: 'request_too_large' },
    maxResults: 8,
  },
]

export function rankingInput(spec) {
  return {
    candidates: spec.candidates,
    judgements: new Map(spec.judgements),
    preferences: spec.preferences ?? [],
    ...(spec.params ? { params: spec.params } : {}),
    maxResults: spec.maxResults,
    ...(spec.mu === undefined || spec.mu === null ? {} : { mu: spec.mu }),
    dedupe: spec.dedupe ?? false,
    unassessable: spec.unassessable ?? {},
  }
}

export const SCORING_OUTPUT_FIELDS = [
  'policyVersion', 'baseNormalized', 'valueUtility', 'sourceDiscountFactor',
  'baseContribution', 'valueContribution', 'coreScore', 'sourcePenalty',
  'preferenceValue', 'preferenceBonus', 'finalScore', 'selectionScore',
]

export const SNAPSHOT_OUTPUT_FIELDS = [
  'evidenceId', 'assocId', 'questionId', 'key', 'url', 'title', 'domain',
  'published', 'text', 'basis', 'textVersion', 'scoreVersion', 'baseScore',
  'engines', 'engineRanks', 'provenance', 'provenanceBasis', 'safetyState',
]

const ADMIT_RESULT_FIELDS = [
  'id', 'evidenceId', 'url', 'title', 'description', 'basis', 'published',
  'textVersion', 'scoreVersion', 'safetyState', 'engineRanks', 'engines',
  'valueLevel', 'valueLabel', 'fusionScore', 'baseNormalized', 'valueUtility',
  'baseContribution', 'valueContribution', 'sourceDiscount',
  'sourceDiscountFactor', 'sourcePenalty', 'sourceDiscountSelectedBy',
  'preferenceMatches', 'preferenceBonus', 'finalScore', 'redundancy',
  'selectionScore',
]

export const ADMIT_DIAGNOSTIC_FIELDS = [
  'collected', 'pending', 'safetyRejected', 'safetyUnavailable',
  'qualityAssessed', 'valueFiltered', 'valueUnestablished',
  'assessmentUnavailable', 'baseScoreMissing', 'requestTooLarge',
  'judgementUnavailable', 'selected', 'valueCounts', 'duplicatesFolded',
]

const pick = (row, fields) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null]))

export function projectScoring(output) {
  return pick(output, SCORING_OUTPUT_FIELDS)
}

export function projectSnapshot(rows) {
  return rows.map((row) => pick(row, SNAPSHOT_OUTPUT_FIELDS))
}

export function projectAdmit(artifact) {
  return {
    results: artifact.results.map((row) => ({
      ...pick(row, ADMIT_RESULT_FIELDS),
      signals: {
        valueConfidence: row.signals?.valueConfidence ?? null,
        discountConfidence: row.signals?.discountConfidence ?? null,
      },
    })),
    valueGroups: artifact.valueGroups,
    selection: artifact.selection,
    diagnostics: pick(artifact.diagnostics, ADMIT_DIAGNOSTIC_FIELDS),
    params: artifact.params,
    policyVersion: artifact.policyVersion,
    sourceBiasPolicyVersion: artifact.sourceBiasPolicyVersion,
  }
}
