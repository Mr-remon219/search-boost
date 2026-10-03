// Frozen pure-data contract for v1 saved research snapshots.
//
// The v1 material/metadata shape lived in lib/search/adaptive/output.js while the
// keyword-driven runner was alive. That runner is retired, so the *data* shape is
// frozen here, independently of any execution code: this module only decodes and
// whitelists stored v1 records plus the read-only historical response branch.
// It must never grow selection/ranking/Jev logic, and new writes never use it.
import * as z from 'zod'

export const LEGACY_SNAPSHOT_FORMAT = 'search-boost-research-v1'
export const LEGACY_SNAPSHOT_ID_PATTERN = '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
export const LEGACY_SNAPSHOT_ID = new RegExp(LEGACY_SNAPSHOT_ID_PATTERN)

/** One stored v1 material row (exact original fields, nothing invented). */
export const legacyResultRow = z.object({
  url: z.string(), title: z.string(), description: z.string(),
  tier: z.enum(['focus', 'supporting']).optional(),
  valueScore: z.number().optional(),
  directionMatch: z.number().nullable().optional(),
  kind: z.string().optional(),
  matches: z.array(z.object({
    taskId: z.string().nullable(), targetId: z.string().nullable(), canonicalId: z.string().nullable(),
    valueScore: z.number(), directionMatch: z.number().nullable(), kind: z.string(),
  })).optional(),
})

/** Original v1 input summary: kept verbatim for historical display only. */
export const legacyInputSummary = z.object({
  question: z.string(), intent: z.string(), keywords: z.array(z.string()),
  constraints: z.array(z.string()), constraintPolicy: z.literal('explicit_per_material'),
})

const legacyMatchPoint = z.object({ keyword: z.string(), progress: z.number().min(0).max(1), minimumMet: z.boolean() })

/** Everything v1 stored beside the materials. Fields absent from a file stay absent. */
export const legacyMetadata = z.object({
  inputSummary: legacyInputSummary,
  retrievalSufficient: z.boolean().optional(),
  scopeSummary: z.object({ eligible: z.number(), rejected: z.number(), unknown: z.number() }).optional(),
  convergence: z.object({
    method: z.literal('score_threshold_v1'), status: z.enum(['satisfied', 'insufficient']),
    score: z.number().min(0).max(100), totalThreshold: z.number(), keywordTarget: z.number(), keywordFloor: z.number(),
    minimumProgress: z.number(), keywordCount: z.number(), points: z.array(legacyMatchPoint),
  }).optional(),
  finalReview: z.object({
    status: z.enum(['not_run', 'not_ready', 'finish', 'continue', 'pending', 'stale']), checks: z.number(),
    verdict: z.enum(['pass', 'not_passed']).nullable().optional(), researchKeyword: z.string().nullable().optional(),
    inputMaterials: z.number().optional(), allMaterialsIncluded: z.boolean().optional(),
  }).optional(),
  reviewSummary: z.object({
    collectedRows: z.number(), assessmentUnavailable: z.number(), unreviewed: z.number(), collected: z.number(),
    withText: z.number(), scopeAssessed: z.number(), scopeSkipped: z.number(), constraintsNotPassed: z.number(),
    qualityAssessed: z.number(), qualityNotPassed: z.number(), admitted: z.number(), focus: z.number(),
    supporting: z.number(), awaitingAdmission: z.number(),
  }).optional(),
  coverageComplete: z.boolean(),
  keywordProgress: z.array(z.object({
    targetId: z.string(), taskId: z.string().nullable().optional(), canonicalId: z.string().optional(),
    keyword: z.string(), score: z.number(), ready: z.boolean().optional(),
    status: z.enum(['continue', 'satisfied', 'exhausted', 'pending']).optional(), reason: z.string().optional(),
    distinctEvidence: z.number(), admitted: z.number().optional(), finalStatus: z.string(),
    progress: z.number().min(0).max(1).optional(), A: z.number().optional(), F: z.number().optional(), R: z.number().optional(),
    missingFacts: z.array(z.string()).optional(),
    factProgress: z.array(z.object({ id: z.string(), support: z.number(), covered: z.boolean(), conflicting: z.boolean() })).optional(),
  })).optional(),
  pendingAssessments: z.number().optional(),
  schemaVersion: z.number().optional(),
  stopReason: z.string(),
  warnings: z.array(z.string()),
}).refine((value) => value.schemaVersion !== 3 || value.coverageComplete === false)

/** One stored v1 file: format/id/savedAt plus materials and metadata. */
export const legacySnapshotDocument = z.object({
  format: z.literal(LEGACY_SNAPSHOT_FORMAT),
  id: z.string().regex(LEGACY_SNAPSHOT_ID),
  savedAt: z.string().datetime(),
  results: z.array(legacyResultRow),
  metadata: legacyMetadata,
})

/**
 * Decode one v1 record through the frozen whitelist. Unknown fields are dropped
 * recursively and no Zod issue text (which could echo stored content) escapes.
 */
export function parseLegacySnapshot(doc) {
  const parsed = legacySnapshotDocument.safeParse(doc)
  if (!parsed.success) throw new Error('Saved research results are unreadable or invalid; no search was performed')
  return parsed.data
}

const nullableString = { type: ['string', 'null'] }
const number = { type: 'number' }
const string = { type: 'string' }
/**
 * Read-only historical response branch: the original v1 record plus the page
 * fields every restore returns. `restoration` is generated by the trusted restore
 * code, never read out of a file. No v5 field (selection/run/valueLevel/...) is
 * part of this branch, so a historical page cannot masquerade as a new run.
 */
export const LEGACY_HISTORICAL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Original v1 metadata, displayed unchanged.
    inputSummary: {
      type: 'object', additionalProperties: false,
      properties: { question: string, intent: string, keywords: { type: 'array', items: string }, constraints: { type: 'array', items: string }, constraintPolicy: { type: 'string', enum: ['explicit_per_material'] } },
      required: ['question', 'intent', 'keywords', 'constraints', 'constraintPolicy'],
    },
    retrievalSufficient: { type: 'boolean' },
    scopeSummary: {
      type: 'object', additionalProperties: false,
      properties: { eligible: number, rejected: number, unknown: number }, required: ['eligible', 'rejected', 'unknown'],
    },
    convergence: {
      type: 'object', additionalProperties: false,
      properties: {
        method: { type: 'string', enum: ['score_threshold_v1'] }, status: { type: 'string', enum: ['satisfied', 'insufficient'] },
        score: number, totalThreshold: number, keywordTarget: number, keywordFloor: number, minimumProgress: number, keywordCount: number,
        points: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { keyword: string, progress: number, minimumMet: { type: 'boolean' } }, required: ['keyword', 'progress', 'minimumMet'] } },
      },
      required: ['method', 'status', 'score', 'totalThreshold', 'keywordTarget', 'keywordFloor', 'minimumProgress', 'keywordCount', 'points'],
    },
    finalReview: {
      type: 'object', additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['not_run', 'not_ready', 'finish', 'continue', 'pending', 'stale'] }, checks: number,
        verdict: { type: ['string', 'null'] }, researchKeyword: nullableString, inputMaterials: number, allMaterialsIncluded: { type: 'boolean' },
      },
      required: ['status', 'checks'],
    },
    reviewSummary: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['collectedRows', 'assessmentUnavailable', 'unreviewed', 'collected', 'withText', 'scopeAssessed', 'scopeSkipped', 'constraintsNotPassed', 'qualityAssessed', 'qualityNotPassed', 'admitted', 'focus', 'supporting', 'awaitingAdmission'].map((key) => [key, number])),
      required: ['collectedRows', 'assessmentUnavailable', 'unreviewed', 'collected', 'withText', 'scopeAssessed', 'scopeSkipped', 'constraintsNotPassed', 'qualityAssessed', 'qualityNotPassed', 'admitted', 'focus', 'supporting', 'awaitingAdmission'],
    },
    coverageComplete: { type: 'boolean', description: 'Deprecated v1 field: the keyword flow never assessed answer completeness.' },
    keywordProgress: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          targetId: string, taskId: nullableString, canonicalId: string, keyword: string, score: number, ready: { type: 'boolean' },
          status: { type: 'string', enum: ['continue', 'satisfied', 'exhausted', 'pending'] }, reason: string,
          distinctEvidence: number, admitted: number, finalStatus: string, progress: number, A: number, F: number, R: number,
          missingFacts: { type: 'array', items: string },
          factProgress: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: string, support: number, covered: { type: 'boolean' }, conflicting: { type: 'boolean' } }, required: ['id', 'support', 'covered', 'conflicting'] } },
        },
        required: ['targetId', 'keyword', 'score', 'distinctEvidence', 'finalStatus'],
      },
    },
    pendingAssessments: number,
    schemaVersion: number,
    stopReason: string,
    warnings: { type: 'array', items: string },
    // Original stored materials, unchanged.
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          url: string, title: string, description: string,
          tier: { type: 'string', enum: ['focus', 'supporting'] }, valueScore: number, directionMatch: { type: ['number', 'null'] },
          kind: string,
          matches: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { taskId: nullableString, targetId: nullableString, canonicalId: nullableString, valueScore: number, directionMatch: { type: ['number', 'null'] }, kind: string },
              required: ['taskId', 'targetId', 'canonicalId', 'valueScore', 'directionMatch', 'kind'],
            },
          },
        },
        required: ['url', 'title', 'description'],
      },
    },
    // Page envelope added by the read-only restore.
    totalResults: { type: 'integer', minimum: 0 },
    pageResults: { type: 'integer', minimum: 0 },
    nextCursor: nullableString,
    expiresAt: string,
    savedAt: nullableString,
    restoration: {
      type: 'object', additionalProperties: false,
      properties: {
        historical: { type: 'boolean', enum: [true] },
        originalFormat: { type: 'string', enum: [LEGACY_SNAPSHOT_FORMAT] },
        originalSchemaVersion: { type: ['number', 'null'] },
      },
      required: ['historical', 'originalFormat', 'originalSchemaVersion'],
    },
  },
  required: ['results', 'totalResults', 'nextCursor', 'expiresAt', 'stopReason', 'warnings', 'coverageComplete', 'inputSummary', 'restoration'],
}
