// Evidence readiness, not calibrated probability. The final gap check is mandatory.
// F uses fixed acceptance facts; R rewards only additional independent provenance
// for the SAME fact and stance. A late new fact has no global document-rank penalty.
export const FACT_SCORE_WEIGHTS = Object.freeze({ alpha: 0.25, beta: 0.90, gamma: 0.10, rho: 0.5 })
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const normalizedText = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function shingles(text) {
  const normalized = normalizedText(text)
  return new Set(Array.from({ length: Math.max(0, normalized.length - 4) }, (_, i) => normalized.slice(i, i + 5)))
}

/** Kept for diagnostics; containment is NOT a safe whole-document deletion rule. */
export function similarity(a, b) {
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const part of a) if (b.has(part)) overlap++
  return overlap / Math.min(a.size, b.size)
}

/** Conservative grouping, not a public-suffix parser or independent-source proof.
 * It may undercount unrelated co.uk/github.io authors. Only R is affected, not F. */
export function sourceGroup(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.') }
  catch { return 'unknown' }
}

/**
 * Duplicate-discount grouping for retrieval R: same site or near-identical text.
 * Exposed so the default reading-value index can reuse the conservative site +
 * near-copy grouping without re-deriving a second, weaker duplicator. It never
 * deletes a document and never affects F, only the supplementary-credit R.
 * Rows must carry `evidenceId`, `text` and `url`.
 */
export function contentGroups(rows) {
  return provenanceGroups(rows)
}

const compare = (a,b) => String(a)<String(b) ? -1 : String(a)>String(b) ? 1 : 0

function eligible(row, gateRelevant, gateStates) {
  const j = row.judgment
  return Boolean(normalizedText(row.text)) && ['relevant', 'states_evidence', 'injection'].every(key => probability(j?.[key]))
    && j.relevant > gateRelevant && j.states_evidence > gateStates && j.injection <= 0.7
}
const quality = row => Math.min(row.judgment.relevant, row.judgment.states_evidence)
const byStrength = (a, b) => b.strength - a.strength || compare(a.row.evidenceId,b.row.evidenceId)

/** Site and high symmetric-text similarity merge provenance groups transitively.
 * This discounts possible copies in R only: a superset can still add a new fact.
 * Semantic paraphrases additionally need explicit first-hand provenance verdicts;
 * URL/domain differences alone never grant corroboration. */
function provenanceGroups(rows) {
  const parent = rows.map((_, i) => i)
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a, b) => { parent[root(b)] = root(a) }
  const texts = rows.map(row => normalizedText(row.text))
  const sets = rows.map(row => shingles(row.text))
  const sites = rows.map(row => sourceGroup(row.url))
  // Exact text/site unions are exhaustive. Near-copy checks use deterministic
  // MinHash blocking with bounded buckets: heuristic, not a semantic proof.
  // This avoids O(n² * fragment length) blocking the host deadline at 500+ rows.
  const buckets = new Map(), bySite = new Map(), byText = new Map()
  const order = rows.map((_,i)=>i).sort((a,b)=>compare(texts[a],texts[b]) || compare(rows[a].url,rows[b].url))
  for (const i of order) {
    if (bySite.has(sites[i])) union(i,bySite.get(sites[i]))
    else bySite.set(sites[i],i)
    if (byText.has(texts[i])) { union(i,byText.get(texts[i])); continue }
    byText.set(texts[i],i)
    const minima = Array(8).fill(0xffffffff)
    for (const token of sets[i]) {
      let hash=2166136261
      for (let c=0;c<token.length;c++) hash=Math.imul(hash^token.charCodeAt(c),16777619)
      for(let b=0;b<minima.length;b++) {
        let mixed=hash^Math.imul(b+1,0x9e3779b9)
        mixed=Math.imul(mixed^(mixed>>>16),0x85ebca6b)
        mixed=Math.imul(mixed^(mixed>>>13),0xc2b2ae35)
        minima[b]=Math.min(minima[b],(mixed^(mixed>>>16))>>>0)
      }
    }
    const keys=sets[i].size ? minima.map((value,b)=>`${b}:${value}`) : []
    const candidates=new Set()
    for(const key of keys) for(const j of buckets.get(key)??[]) {
      if(candidates.size>=96) break
      if(root(i)!==root(j)) candidates.add(j)
    }
    for(const j of candidates) {
      if(root(i)===root(j)) continue
      const a=sets[i],b=sets[j]
      if(!a.size || !b.size || Math.min(a.size,b.size)/Math.max(a.size,b.size)<.9) continue
      let overlap=0
      for(const token of a) if(b.has(token)) overlap++
      if(overlap/(a.size+b.size-overlap)>=.9) union(i,j)
    }
    for(const key of keys) {
      if(!buckets.has(key)) buckets.set(key,[])
      const bucket=buckets.get(key)
      if(bucket.length<64) bucket.push(i)
    }
  }
  return new Map(rows.map((row, i) => [row, root(i)]))
}

/**
 * A = max q; F = sum w_f max a_df; R = sum w_f (bounded geometric corroboration).
 * coverageRows may share target-wide factual evidence across keyword synonyms;
 * a keyword still needs its OWN qualifying evidence to get A or become ready.
 * All rows must be current-version, date/constraint-qualified associations.
 */
export function scoreEvidence(rows, { gate = .60, gateRelevant = gate, gateStates = gate, factGate = .60, provenanceGate = .85,
  facts = [], coverageRows = rows, weights = FACT_SCORE_WEIGHTS, provenanceCache } = {}) {
  const { alpha, beta, gamma, rho } = weights
  if (![alpha, beta, gamma, rho].every(Number.isFinite) || alpha < 0 || beta < 0 || gamma < 0 || rho <= 0 || rho >= 1
    || alpha + gamma >= 1 || alpha + beta <= 1) throw new Error('Invalid fact-score weights')
  const local = rows.filter(row => eligible(row, gateRelevant, gateStates))
  const material = coverageRows.filter(row => eligible(row, gateRelevant, gateStates))
  // A cache is scoped by the caller to this immutable evidence snapshot only;
  // sharing keyword spelling alternatives must not repeat quadratic text work.
  let groups = provenanceCache?.get(coverageRows)
  if (!groups) {
    groups = provenanceGroups(material.filter(row => !row.bundle))
    provenanceCache?.set(coverageRows, groups)
  }
  const seenIds = new Set()
  const definitions = facts.map(f => {
    if (!f?.id || seenIds.has(f.id) || !Number.isFinite(f.weight) || f.weight <= 0) throw new Error('Invalid fact definition')
    seenIds.add(f.id)
    return f
  })
  if (definitions.length && Math.abs(definitions.reduce((sum, f) => sum + f.weight, 0) - 1) > 1e-9) throw new Error('Fact weights must sum to one')
  const A = local.length ? Math.max(...local.map(quality)) : 0
  let F = 0, R = 0
  const contributions = new Map(), witnesses = new Set(), factProgress = []
  function credit(row, delta) {
    if (delta <= 0) return
    const id = row.evidenceId
    contributions.set(id, { id, delta: (contributions.get(id)?.delta ?? 0) + delta })
  }
  if (local.length) credit([...local].sort((a, b) => quality(b) - quality(a) || compare(a.evidenceId,b.evidenceId))[0], alpha * A)
  for (const fact of definitions) {
    const supporters = []
    for (const row of material) {
      const j = row.facts?.find(item => item.factId === fact.id)
      if (!j || !probability(j.support) || !['support', 'refute'].includes(j.stance) || j.support <= factGate) continue
      supporters.push({ row, strength: j.support, stance: j.stance, independent: !row.bundle && probability(j.independent) && j.independent > provenanceGate })
    }
    supporters.sort(byStrength)
    const best = supporters[0]
    const support = best?.strength ?? 0
    F += fact.weight * support
    if (best) { for (const id of best.row.witnesses ?? [best.row.evidenceId]) witnesses.add(id); credit(best.row, beta * fact.weight * support) }
    // Opposing stances are never mutual corroboration. Retain both for the final
    // conflict check, even if one would be crowded out by high-scoring copies.
    const stances = ['support', 'refute'].map(stance => supporters.filter(s => s.stance === stance))
    let corroboration = 0, corroborators = []
    for (const members of stances) {
      if (members[0]) for (const id of members[0].row.witnesses ?? [members[0].row.evidenceId]) witnesses.add(id)
      const independentGroups = new Map()
      for (const item of members) if (item.independent && !independentGroups.has(groups.get(item.row))) independentGroups.set(groups.get(item.row), item)
      const extras = [...independentGroups.values()].sort(byStrength).slice(1)
      const value = extras.reduce((sum, item, i) => sum + (1 - rho) * rho ** i * item.strength, 0)
      if (value > corroboration) { corroboration = value; corroborators = extras }
    }
    R += fact.weight * corroboration
    corroborators.forEach((item, i) => credit(item.row, gamma * fact.weight * (1 - rho) * rho ** i * item.strength))
    factProgress.push({ id: fact.id, support, covered: Boolean(best), conflicting: stances.every(items => items.length > 0) })
  }
  // Unknown facts never receive credit. A useful keyword snippet alone cannot
  // substitute for target-wide acceptance facts, nor vice versa.
  const score = alpha * A + beta * F + gamma * R
  const missingFacts = factProgress.filter(f => !f.covered).map(f => f.id)
  const groupById = new Map(material.filter(row=>!row.bundle).map(row=>[row.evidenceId,groups.get(row)]))
  return { score, ready: local.length > 0 && definitions.length > 0 && !missingFacts.length && score > 1,
    A, F, R, eligible: local.length, distinct: new Set(local.map(row=>groupById.get(row.evidenceId)).filter(id=>id!==undefined)).size,
    missingFacts,
    factProgress, witnesses: [...witnesses], contributions: [...contributions.values()] }
}

/** Global next-round quota. Zero remaining means final check, never more search. */
export function nextPoolLimit(remaining, total, { maxPoolRowsPerRound = 500, recoveryConstant = 1.25, minPoolRowsPerRound = 24 } = {}) {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(remaining) || remaining < 0 || remaining > total) throw new Error('Invalid keyword counts')
  return remaining === 0 ? 0 : Math.min(maxPoolRowsPerRound, Math.max(minPoolRowsPerRound, Math.ceil(maxPoolRowsPerRound * recoveryConstant * remaining / total)))
}

export function keywordList(question) {
  const keywords = question.keywords?.filter(k => typeof k === 'string' && k.trim()).map(k => k.trim())
  return keywords?.length ? [...new Set(keywords)] : [String(question.acceptance ?? question.text ?? '').trim()]
}
