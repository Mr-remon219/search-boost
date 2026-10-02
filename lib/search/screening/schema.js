// Shared output contract for the single N_off adaptive flow. One definition per
// branch (schema-v5 run, read-only v1 historical restore) plus their exact-one
// union; hosts translate this instead of re-declaring semantics. The private
// persistence layer uses the v5 metadata projection of the same module.
import { LEGACY_HISTORICAL_OUTPUT_SCHEMA } from './legacy-snapshot.js'
const string = { type: 'string' }, number = { type: 'number' }, integer = { type: 'integer' }, boolean = { type: 'boolean' }
const nullableString = { type: ['string', 'null'] }, nullableNumber = { type: ['number', 'null'] }
const array = (items) => ({ type: 'array', items })
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({ type: 'object', properties, required, additionalProperties })
const numberMap = { type: 'object', additionalProperties: number }

export const ADAPTIVE_V5_SCHEMA_VERSION = 5

const row = object({
  id: string, rank: { type: 'integer', minimum: 1 }, evidenceId: string, url: string, title: string, description: string,
  basis: nullableString, published: nullableString, textVersion: nullableString, scoreVersion: nullableString,
  safetyState: { type: 'string', enum: ['clear'] },
  engineRanks: numberMap, engines: array(string),
  valueLevel: { type: 'integer', enum: [3, 4, 5] }, valueLabel: { type: 'string', enum: ['medium', 'medium_high', 'high'] },
  ...Object.fromEntries(['fusionScore', 'baseNormalized', 'valueUtility', 'baseContribution', 'valueContribution', 'sourceDiscountFactor', 'sourcePenalty', 'preferenceBonus', 'finalScore', 'redundancy', 'selectionScore'].map((key) => [key, number])),
  sourceDiscount: { type: 'string', enum: ['none', 'mild', 'strong', 'unknown'] }, sourceDiscountSelectedBy: nullableString,
  preferenceMatches: array({ type: 'string', enum: ['match', 'partial', 'no_match', 'unknown'] }),
  // Only the meaningfully decoded confidences: they are audited, never scored.
  signals: object({ valueConfidence: nullableNumber, discountConfidence: nullableNumber }),
})

// run.community: finite code-owned decision + actual execution status, never
// model reasoning. Missing execution metadata keeps requested/effective honest
// and is disclosed through reason, not guessed as success.
// `input`/`choice` are spelled as disjoint oneOf branches instead of mixed-type
// enums: that keeps the union translatable by the stricter DSH schema subset
// without weakening it (no arbitrary object, still exactly one valid branch).
const communityMode = { oneOf: [{ type: 'string', enum: ['auto'] }, { type: 'boolean' }] }
const communityStatus = object({
  input: communityMode,
  source: { type: 'string', enum: ['jev', 'explicit'] },
  choice: { oneOf: [{ type: 'string', enum: ['enable', 'disable', 'unknown', 'unavailable'] }, { type: 'null' }] },
  requested: { type: ['boolean', 'null'] },
  effective: boolean,
  outcome: { type: 'string', enum: ['not_requested', 'domain_excluded', 'unavailable', 'blocked', 'succeeded', 'empty', 'failed', 'partial', 'not_run'] },
  cacheHit: boolean,
  reason: nullableString,
  // Bounded counters and fixed dispatch/reuse flags, not free-form provider data.
  // Unknown HTTP/token counters stay null; reuse counts no new dispatch.
  usage: object({
    officialAttempted: boolean, fallbackAttempted: boolean, dispatchedNow: boolean, inFlight: boolean,
  }, [], { type: ['integer', 'null'], minimum: 0 }),
})

const engineStats = {
  type: 'object',
  additionalProperties: object({
    used: boolean, attempts: { type: 'integer', minimum: 0 }, successes: { type: 'integer', minimum: 0 }, errors: { type: 'integer', minimum: 0 },
  }),
}

const runRecord = object({
  halted: nullableString,
  budgetVersion: string,
  limits: object(Object.fromEntries([
    'candidateLimit', 'batchSize', 'rescueReads', 'maxJevRetries', 'maxJevResponseBytes', 'maxInitialTextChars',
    'jevPerRequestMs', 'jevMaxBackoffMs', 'maxStateChars', 'maxRequestChars',
  ].map((key) => [key, integer]))),
  strategy: object({
    ranking: object({ state: { type: 'string', enum: ['selected', 'fallback', 'unavailable'] }, ranking: nullableString }),
    community: object({ state: { type: 'string', enum: ['explicit', 'selected', 'unavailable'] }, choice: nullableString }),
  }),
  ranking: nullableString,
  enginePool: nullableString,
  cacheHit: boolean,
  queriesUsed: array(string),
  effectiveWeights: numberMap,
  engineStats,
  community: communityStatus,
  reviewRule: string,
  targetExceedsReviewCap: boolean,
  diversity: string,
  decisions: array(object({ evidenceId: string, admitted: boolean, reason: string })),
  decisionCount: { type: 'integer', minimum: 0 },
  decisionsTruncated: boolean,
  batches: { type: 'integer', minimum: 0 },
  judgeFailures: { type: 'integer', minimum: 0 },
  judgeFailedIds: array(string),
  jevModel: nullableString,
  host: string,
  snapshotCandidates: { type: 'integer', minimum: 0 },
  outsideReview: { type: 'integer', minimum: 0 },
  unreviewed: { type: 'integer', minimum: 0 },
})

export const ADAPTIVE_V5_OUTPUT_SCHEMA = object({
  schemaVersion: { type: 'integer', enum: [ADAPTIVE_V5_SCHEMA_VERSION] },
  policyVersion: string, judgementPolicyVersion: string, strategyPolicyVersion: string,
  admissionPolicyVersion: string, sourceBiasPolicyVersion: string,
  results: array(row), valueGroups: object({ 3: array(string), 4: array(string), 5: array(string) }),
  selection: object({
    requested: { type: 'integer', minimum: 1 }, returned: { type: 'integer', minimum: 0 },
    targetMet: boolean, stopReason: string, incomplete: boolean,
  }),
  diagnostics: numberMap,
  usage: object({
    ...Object.fromEntries([
      'fusedCalls', 'jevCalls', 'jevHttpAttempts', 'jevRetries', 'jevInputTokensEstimated', 'jevTokensEstimatedReserved',
      'jevUsageUnknownAttempts', 'serverUsageCalls', 'unknownUsageCalls', 'fetchReads', 'fetchCalls', 'fetchCacheReads',
    ].map((key) => [key, { type: 'integer', minimum: 0 }])),
    engineRequests: nullableNumber, engineHttpRequests: nullableNumber,
    fetchHttpRequests: { type: 'integer', minimum: 0 }, jevInputTokens: nullableNumber, jevOutputTokens: nullableNumber,
  }),
  params: object({
    tau: number, lambda: number, epsilon: number, mu: number,
    utilities: numberMap, discountFactors: numberMap, preferenceMatchValues: numberMap,
  }),
  run: runRecord,
  totalResults: { type: 'integer', minimum: 0 },
  pageResults: { type: 'integer', minimum: 0 },
  nextCursor: nullableString,
  expiresAt: string,
  stopReason: string,
  warnings: array(string),
  savedResultId: string,
  inputSummary: object({
    question: string, intent: string, preferences: array(string),
    community: communityMode, maxResults: { type: 'integer', minimum: 1 },
  }),
  error: string,
}, [
  'schemaVersion', 'policyVersion', 'judgementPolicyVersion', 'strategyPolicyVersion', 'admissionPolicyVersion',
  'sourceBiasPolicyVersion', 'results', 'valueGroups', 'selection', 'diagnostics', 'usage', 'params', 'run',
  'totalResults', 'pageResults', 'nextCursor', 'expiresAt', 'stopReason', 'warnings',
])

/** Page-envelope keys added by the shared page pool, not by a run itself. */
const PAGE_KEYS = Object.freeze(['totalResults', 'pageResults', 'nextCursor', 'expiresAt'])

/**
 * The v5 metadata projection a new run stores beside its materials: the same
 * typed contract minus the materials and page envelope (and minus savedResultId,
 * which is only assigned after a successful write). Both the v2 private
 * persistence writer and the readers validate against this definition.
 */
export const ADAPTIVE_V5_METADATA_SCHEMA = {
  ...ADAPTIVE_V5_OUTPUT_SCHEMA,
  properties: Object.fromEntries(Object.entries(ADAPTIVE_V5_OUTPUT_SCHEMA.properties)
    .filter(([key]) => key !== 'results' && key !== 'savedResultId' && !PAGE_KEYS.includes(key))),
  required: ADAPTIVE_V5_OUTPUT_SCHEMA.required.filter((key) => key !== 'results' && !PAGE_KEYS.includes(key)),
}

/**
 * Exact-one union of the two supported response branches:
 *  - a schema-v5 run (new research, paged or restored from a v2 file)
 *  - a read-only historical restore of a frozen v1 file (marked `restoration`)
 * Every field is typed and unknown fields are rejected; this is not an arbitrary
 * object. Hosts translate this definition, never a second copy of it.
 */
export const ADAPTIVE_OUTPUT_SCHEMA = {
  oneOf: [ADAPTIVE_V5_OUTPUT_SCHEMA, LEGACY_HISTORICAL_OUTPUT_SCHEMA],
  description: 'adaptive_search response: either a schema-v5 screening run or a read-only historical (v1) restore whose restoration.historical marker states that it was not re-searched, re-screened or re-verified.',
}
