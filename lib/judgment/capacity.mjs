// Offline evidence, not a tokenizer estimate or an HTTP token-preflight API.
// A deployment owner can export measured fixed-head fixtures using their pinned
// tokenizer. The file is data in the canonical private user store, never code.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { readJsonStore } from '../private-file.mjs'
import { DecisionError, frozenCopy, isRecord, normalizeDecisionBaseUrl } from './contract.mjs'

export const headFingerprint = question => createHash('sha256').update(JSON.stringify({
  type: question.type, instructions: question.instructions, criteria: question.criteria,
  ...(question.labels !== undefined ? { labels: question.labels } : {}),
})).digest('hex')
const positive = value => Number.isSafeInteger(value) && value > 0
const count = value => Number.isSafeInteger(value) && value >= 0
const revision = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
export const capacityFilePath = profileId => join(searchBoostHome(), 'config', 'judgment-capacity', `${profileId}.json`)

export function validateCapacityManifest(raw, profile) {
  if (!isRecord(raw) || raw.version !== 1 || normalizeDecisionBaseUrl(raw.baseUrl) !== profile.baseUrl ||
      raw.model !== profile.model || raw.layaVersion !== '0.3.26' ||
      raw.sourceRevision !== '2e4d9c87e8b1621deb344eac7de5c7258f32f849' ||
      typeof raw.repo !== 'string' || !/^[A-Za-z0-9_.:/@-]{1,200}$/.test(raw.repo) ||
      !revision(raw.modelRevision) || !revision(raw.tokenizerRevision) ||
      !positive(raw.maxLen) || !positive(raw.headMaxLen) || raw.headMaxLen >= raw.maxLen ||
      !isRecord(raw.heads) || Object.keys(raw.heads).some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
      (profile.options?.max_len != null && profile.options.max_len !== raw.maxLen) ||
      (profile.options?.head_max_len != null && profile.options.head_max_len !== raw.headMaxLen)) {
    throw new DecisionError('invalid_config', { detail: 'capacity_manifest_mismatch' })
  }
  // Copy only known fields. Raw local manifest data never leaks to providers,
  // capability output, logs or saved research records.
  return frozenCopy({
    version: 1, baseUrl: profile.baseUrl, model: raw.model, layaVersion: raw.layaVersion,
    sourceRevision: raw.sourceRevision, repo: raw.repo, modelRevision: raw.modelRevision,
    tokenizerRevision: raw.tokenizerRevision, maxLen: raw.maxLen, headMaxLen: raw.headMaxLen, heads: raw.heads,
  })
}
export function readCapacityEvidence(profileId, profile) {
  const { exists, doc, error } = readJsonStore(capacityFilePath(profileId))
  if (error) return { manifest: null, status: 'unreadable' }
  if (!exists) return { manifest: null, status: 'missing' }
  try { return { manifest: validateCapacityManifest(doc, profile), status: 'loaded' } }
  catch { return { manifest: null, status: 'mismatch' } }
}
export function readCapacityManifest(profileId, profile) { return readCapacityEvidence(profileId, profile).manifest }
export function createHeadVerifier(manifest) {
  return ({ question, profile, routing }) => {
    if (!manifest || profile.model !== manifest.model || routing?.repo !== manifest.repo ||
        (profile.options?.max_len != null && profile.options.max_len !== manifest.maxLen) ||
        (profile.options?.head_max_len != null && profile.options.head_max_len !== manifest.headMaxLen)) return false
    const fixture = manifest.heads[headFingerprint(question)]
    const n = question.type === 'noul' ? 2 : Object.keys(question.criteria).length
    return isRecord(fixture) && positive(fixture.headTokens) && fixture.headTokens <= manifest.headMaxLen &&
      count(fixture.instructionsTokens) && fixture.instructionsTokens === fixture.retainedInstructionsTokens &&
      Array.isArray(fixture.optionTokens) && fixture.optionTokens.length === n &&
      Array.isArray(fixture.retainedOptionTokens) && fixture.retainedOptionTokens.length === n &&
      fixture.optionTokens.every((tokens, i) => count(tokens) && tokens <= 48 && tokens === fixture.retainedOptionTokens[i])
  }
}
