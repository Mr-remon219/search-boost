import { join } from 'node:path'
import { searchBoostHome } from '../config-paths.mjs'
import { readJsonStore, withFileLock, writeFileAtomicPrivate } from '../private-file.mjs'
import { readJevConfig, jevProvider, JEV_DEFAULT_MODEL, JEV_VERCEL_MODEL } from '../jev-config.mjs'
import { decisionRegistry } from './registry.mjs'
import { readCapacityEvidence } from './capacity.mjs'
import { DecisionError, frozenCopy, isRecord } from './contract.mjs'

// User-level only, colocated with existing private keys. No project file,
// provider environment key, arbitrary import or relocated keys-file fallback.
export const judgmentFilePath = () => join(searchBoostHome(), 'config', 'judgment.json')
const profileId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
export function validateJudgmentProfiles(doc) {
  if (!isRecord(doc) || Object.keys(doc).some(key => !['activeProfile', 'profiles'].includes(key)) ||
      !profileId(doc.activeProfile) || !isRecord(doc.profiles) ||
      !Object.hasOwn(doc.profiles, doc.activeProfile) || Object.keys(doc.profiles).some(id => !profileId(id))) {
    throw new DecisionError('invalid_config', { detail: 'invalid_profiles' })
  }
  const profiles = Object.fromEntries(Object.entries(doc.profiles).map(([id, config]) => [id, decisionRegistry.validateConfig(config)]))
  return frozenCopy({ activeProfile: doc.activeProfile, profiles })
}

export function readJudgmentProfiles() {
  const { exists, doc, error } = readJsonStore(judgmentFilePath())
  if (error) throw error
  if (exists) return { ...validateJudgmentProfiles(doc), source: 'file' }
  const old = readJevConfig()
  const vercel = jevProvider(old.baseUrl) === 'vercel'
  const profile = { provider: 'jev', baseUrl: old.baseUrl, apiKey: old.apiKey ?? null,
    transport: vercel ? 'vercel-evaluation' : 'systemone', model: vercel ? JEV_VERCEL_MODEL : JEV_DEFAULT_MODEL, authMode: 'bearer' }
  return frozenCopy({ activeProfile: 'legacy-jev', profiles: { 'legacy-jev': profile }, source: old.apiKey ? 'file' : 'missing', legacy: true })
}

/** Snapshot once for a new run. Bad new config never falls back to old keys. */
export function readJudgmentConfig() {
  const store = readJudgmentProfiles()
  const config = store.profiles[store.activeProfile]
  const capacity = config.provider === 'laya' ? readCapacityEvidence(store.activeProfile, config) : { manifest: null, status: 'not_applicable' }
  return frozenCopy({ ...config, capacityManifest: capacity.manifest, capacityStatus: capacity.status, profileId: store.activeProfile, source: store.source, ready: Boolean(store.legacy ? config.apiKey : true) })
}
export function saveJudgmentProfiles(doc) {
  const valid = validateJudgmentProfiles(doc)
  return withFileLock(judgmentFilePath(), () => {
    const { error } = readJsonStore(judgmentFilePath())
    if (error) throw error
    writeFileAtomicPrivate(judgmentFilePath(), `${JSON.stringify(valid, null, 2)}\n`)
    return valid
  })
}
export function saveJudgmentProfile(id, config, { activate = true } = {}) {
  if (!profileId(id)) throw new DecisionError('invalid_config', { detail: 'invalid_profile_id' })
  const profile = decisionRegistry.validateConfig(config)
  return withFileLock(judgmentFilePath(), () => {
    const current = readJudgmentProfiles()
    // An unconfigured legacy block is not a valid saved profile. A configured
    // legacy block may be explicitly copied by this user-level save.
    const profiles = current.legacy && !current.profiles['legacy-jev'].apiKey ? {} : current.profiles
    const valid = validateJudgmentProfiles({ activeProfile: activate ? id : current.activeProfile, profiles: { ...profiles, [id]: profile } })
    writeFileAtomicPrivate(judgmentFilePath(), `${JSON.stringify(valid, null, 2)}\n`)
    return valid
  })
}
export function activateJudgmentProfile(id) {
  return withFileLock(judgmentFilePath(), () => {
    const current = readJudgmentProfiles()
    const valid = validateJudgmentProfiles({ activeProfile: id, profiles: current.profiles })
    writeFileAtomicPrivate(judgmentFilePath(), `${JSON.stringify(valid, null, 2)}\n`)
    return valid
  })
}

/** Safe capability/readiness: never exports endpoints, credentials or digests. */
export function describeJudgmentForCapability() {
  try {
    const config = readJudgmentConfig()
    return {
      tool: 'adaptive_search', configured: config.ready, source: config.source,
      provider: config.provider, model: config.model, transport: config.transport,
      gateway: 'custom', destination: `the ${config.provider === 'laya' ? 'self-hosted Laya' : 'Jev'} service configured by the user`,
      sends: 'question text, search intent and the fragments required for each judgement are sent to that service',
      note: 'Configuration readiness only; no connectivity, capacity or model-quality claim.',
    }
  } catch {
    return { tool: 'adaptive_search', configured: false, source: 'unreadable', provider: null, model: null,
      destination: 'the judgment service configured by the user', gateway: 'unknown',
      note: 'Judgment configuration unreadable; repair the selected profile. No legacy fallback.' }
  }
}
