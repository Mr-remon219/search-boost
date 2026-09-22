/** Correlation-aware positive-evidence fusion. Cold-start design, not a probability. */
export const SCORE_VERSION = 'consensus-v2.1'
export const SCORE_CONFIG = Object.freeze({
  kappa: 10, beta: 1, metadataClip: 0.2, lexical: 0.10, freshness: 0.15,
  families: Object.freeze({ bing: 'bing', ddg: 'bing', yahoo: 'bing', 'exa-free': 'exa', exa: 'exa' }),
  retention: Object.freeze({ bing: 0.25, exa: 0.20 }),
  aliases: Object.freeze({ 'anysearch-anonymous': 'anysearch', 'anysearch-keyed': 'anysearch' }),
  diversityPenalty: 0.15, sparseDomainCap: 2, authorCap: 2,
})
export const logicalEngine = (name) => SCORE_CONFIG.aliases[name] ?? name

/** One URL, original ONE-based provider ranks. Missing observations are neutral. */
export function scoreEvidence(observations, weights, config = SCORE_CONFIG) {
  if (!Array.isArray(observations) || !weights || typeof weights !== 'object') throw new TypeError('Invalid scoring input')
  if (!Number.isFinite(config.kappa) || config.kappa <= 0 || !Number.isFinite(config.beta) || config.beta < 0) throw new RangeError('Invalid scoring parameters')
  for (const eta of Object.values(config.retention)) if (!Number.isFinite(eta) || eta < 0 || eta > 1) throw new RangeError('Invalid group retention')
  const ranks = new Map()
  for (const observation of observations) {
    if (!observation || typeof observation.engine !== 'string' || !Number.isSafeInteger(observation.rank) || observation.rank < 1) throw new TypeError('Observation requires engine and rank >= 1')
    const engine = config.aliases[observation.engine] ?? observation.engine
    const weight = weights[engine]
    if (!Object.hasOwn(weights, engine) || typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new RangeError(`Invalid weight: ${engine}`)
    ranks.set(engine, Math.min(ranks.get(engine) ?? Infinity, observation.rank))
  }
  const contributions = {}, groups = new Map(), engineRanks = {}
  for (const engine of [...ranks.keys()].sort()) {
    const rank = ranks.get(engine)
    engineRanks[engine] = rank
    const value = weights[engine] * (config.kappa / (config.kappa + rank - 1))
    if (value === 0) continue
    contributions[engine] = value
    const family = config.families[engine] ?? engine
    if (!groups.has(family)) groups.set(family, [])
    groups.get(family).push(value)
  }
  const bestIndividual = Math.max(0, ...Object.values(contributions))
  const groupEvidence = {}
  // Accumulate residual directly, not sum-minus-M: small votes survive rounding
  // beside a strong maximum and large finite weights do not overflow a sum.
  let maximumRemoved = false
  const residuals = []
  for (const family of [...groups.keys()].sort()) {
    const values = groups.get(family).sort((a, b) => b - a)
    const eta = config.retention[family] ?? 1
    const retained = values.map((v, i) => i === 0 ? v : v * eta)
    groupEvidence[family] = { max: values[0], retention: eta }
    for (const [i, value] of retained.entries()) {
      if (!maximumRemoved && i === 0 && value === bestIndividual) maximumRemoved = true
      else if (value > 0) residuals.push(value)
    }
  }
  const scale = Math.max(1, ...residuals)
  const scaled = residuals.reduce((sum, value) => sum + value / scale, 0)
  const logConsensus = scale === 1 ? Math.log1p(scaled) : Math.log(scale) + Math.log(scaled + 1 / scale)
  const consensusBoost = config.beta * logConsensus
  const evidenceScore = bestIndividual + consensusBoost
  return { scoreVersion: SCORE_VERSION, bestIndividual, rankScore: evidenceScore, evidenceScore, consensusBoost,
    contributions, groupEvidence, engineRanks, votingEngines: Object.keys(contributions) }
}
