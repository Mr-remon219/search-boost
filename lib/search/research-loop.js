// Multi-round deep-research loop with evidence-based coverage and claim-level
// alignment. Each round: fused search → fetch top unseen pages → extract
// focus-relevant excerpts → coverage check → follow-up queries.
//
// Coverage is evaluated strictly on selected excerpts (never arbitrary page
// text); goal terms require >=2 independent domains; time-sensitive goals
// additionally require recent, claim-aligned evidence. No LLM is involved —
// the loop never claims the semantic goal is satisfied.
//
// Ported from pi-search-boost lib/research.ts into SearchBoost Core. The
// search and fetch primitives are injected (see lib/runtime.mjs) so the loop
// runs on the shared engine chain in every host.

import { pickExcerpts } from './evidence.js'
import {
  containsSearchTerm, countWords, distinctiveTerms, evidenceTerms, nowIso, pool, throwIfAborted, tokenize,
} from './text.js'

const AUTHORITATIVE_TLDS = ['.gov', '.edu', '.mil']

const GOAL_INSTRUCTION_TERMS = new Set([
  'answer', 'establish', 'identify', 'determine', 'find', 'report', 'provide',
  'explain', 'verify', 'show', 'tell', 'whether', 'must', 'final',
  '回答', '确认', '识别', '确定', '查找', '报告', '说明', '验证', '给出', '最终',
])

const TEMPORAL_TERMS = new Set([
  'current', 'latest', 'newest', 'recent', 'today', 'now', 'status', 'active',
  '当前', '最新', '现在', '现行', '状态', '截至', '今日',
])

const CLAIM_GENERIC_TERMS = new Set([
  'page', 'source', 'official', 'information', 'documentation', 'using', 'used',
  'release', 'releases', 'version', 'versions', 'current', 'latest', 'status',
  '页面', '来源', '官方', '信息', '文档', '使用', '发布', '版本', '状态', '最新', '当前',
])

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** step mode is always one round; auto honors maxRounds (clamped 1–5). */
export function plannedResearchRounds(mode, requested) {
  if (mode === 'step') return 1
  return Math.min(5, Math.max(1, requested ?? 3))
}

export function isTimeSensitiveGoal(text) {
  if (!text) return false
  return evidenceTerms(text).some((term) => TEMPORAL_TERMS.has(term.toLowerCase())) || /\bas\s+of\b/i.test(text)
}

/** Remove instruction verbs: coverage should describe evidence subjects, not prompt wording. */
export function goalCoverageTerms(goal) {
  if (!goal) return []
  return [...new Set(evidenceTerms(goal))].filter(
    (term) => !GOAL_INSTRUCTION_TERMS.has(term.toLowerCase()) && !TEMPORAL_TERMS.has(term.toLowerCase()),
  )
}

function evidenceDomainsForTerm(sources, term) {
  const domains = new Set()
  for (const source of sources) {
    if (source.excerpt && containsSearchTerm(source.excerpt, term)) domains.add(source.domain)
  }
  return domains
}

function yearsIn(text) {
  return [...text.matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)].map((m) => Number(m[1]))
}

function versionTokens(text) {
  const out = new Set()
  for (const m of text.matchAll(/\bv?(\d{1,3}(?:\.\d+){1,3})\b/gi)) out.add(m[1].replace(/\.0+$/, ''))
  for (const m of text.matchAll(/\b(?:node(?:\.js)?|python|rust|go|java)\s*(?:version\s*)?v?(\d{1,3})\b/gi)) out.add(m[1])
  for (const m of text.matchAll(/\bv(\d{1,3})\b/gi)) out.add(m[1])
  return out
}

function factTokens(text) {
  const out = new Set()
  for (const v of versionTokens(text)) out.add(`version:${v}`)
  for (const year of yearsIn(text)) out.add(`year:${year}`)
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|ms|s|gb|mb|tb|kb|x)\b/gi)) {
    out.add(`measure:${m[0].toLowerCase().replace(/\s+/g, '')}`)
  }
  return out
}

function statusTokens(text) {
  const out = new Set()
  const lower = text.toLowerCase()
  if (/\bactive(?:\s+lts)?\b|活跃|积极维护/.test(lower)) out.add('active')
  const isEol = /\bend[- ]of[- ]life\b|\beol\b|停止维护|生命周期结束/.test(lower)
  if (/\bmaintenance(?:\s+lts)?\b/.test(lower) || (/维护/.test(lower) && !isEol)) out.add('maintenance')
  if (isEol) out.add('eol')
  return out
}

function claimSegments(text) {
  const segments = String(text ?? '')
    .split(/\s+\.\.\.\s+|(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 5)
  return segments.length > 0 ? segments : [String(text ?? '')]
}

function intersectSize(a, b) {
  let n = 0
  for (const value of a) if (b.has(value)) n++
  return n
}

function claimTerms(text) {
  return new Set(tokenize(text).filter((t) => t.length >= 3 && !CLAIM_GENERIC_TERMS.has(t.toLowerCase())))
}

function claimsAlign(a, b, focusTerms, timeSensitive) {
  const termsA = claimTerms(a)
  const termsB = claimTerms(b)
  const sharedContent = intersectSize(termsA, termsB)
  const union = new Set([...termsA, ...termsB]).size || 1
  const jaccard = sharedContent / union
  const focusA = new Set([...focusTerms].filter((t) => containsSearchTerm(a, t)))
  const focusB = new Set([...focusTerms].filter((t) => containsSearchTerm(b, t)))
  const sharedFocus = intersectSize(focusA, focusB)

  const versionsA = versionTokens(a)
  const versionsB = versionTokens(b)
  if (versionsA.size > 0 && versionsB.size > 0 && intersectSize(versionsA, versionsB) === 0) return false
  const statusesA = statusTokens(a)
  const statusesB = statusTokens(b)
  if (statusesA.size > 0 && statusesB.size > 0 && intersectSize(statusesA, statusesB) === 0) return false

  const factsA = factTokens(a)
  const factsB = factTokens(b)
  const sharedFacts = intersectSize(factsA, factsB)
  if (timeSensitive) return sharedFacts >= 1 && sharedFocus >= 1 && sharedContent >= 1
  if (factsA.size > 0 && factsB.size > 0) {
    return sharedFacts >= 1 && sharedFocus >= 1 && sharedContent >= 1
  }
  return sharedFocus >= 2 && sharedContent >= 3 && jaccard >= 0.12
}

/**
 * Mark independent domains only when at least one pair of claim-sized segments
 * aligns on subject and either exact factual anchors or strong lexical overlap.
 * Deliberately conservative and heuristic, not proof.
 */
export function applyCorroboration(sources, focus, timeSensitive = isTimeSensitiveGoal(focus)) {
  const focusTerms = new Set(evidenceTerms(focus).filter((t) => !TEMPORAL_TERMS.has(t.toLowerCase())))
  const segments = sources.map((source) => claimSegments(source.excerpt))
  const recentCutoff = new Date().getUTCFullYear() - 1
  for (let i = 0; i < sources.length; i++) {
    const domains = new Set()
    const freshDomains = new Set()
    for (let j = 0; j < sources.length; j++) {
      if (i === j || sources[i].domain === sources[j].domain) continue
      let aligned = false
      let freshAligned = false
      for (const a of segments[i]) {
        for (const b of segments[j]) {
          if (!claimsAlign(a, b, focusTerms, timeSensitive)) continue
          aligned = true
          if (yearsIn(a).some((year) => year >= recentCutoff) && yearsIn(b).some((year) => year >= recentCutoff)) {
            freshAligned = true
          }
        }
      }
      if (aligned) domains.add(sources[j].domain)
      if (freshAligned) freshDomains.add(sources[j].domain)
    }
    sources[i].corroboratedBy = [...domains].sort()
    sources[i].freshCorroboratedBy = [...freshDomains].sort()
  }
}

function freshAlignedDomainsForTerm(sources, term, focusTerms) {
  const domains = new Set()
  const recentCutoff = new Date().getUTCFullYear() - 1
  const segments = sources.map((source) => claimSegments(source.excerpt))
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (sources[i].domain === sources[j].domain) continue
      const alignedFreshClaim = segments[i].some((a) =>
        containsSearchTerm(a, term) && yearsIn(a).some((year) => year >= recentCutoff)
        && segments[j].some((b) =>
          containsSearchTerm(b, term) && yearsIn(b).some((year) => year >= recentCutoff)
          && claimsAlign(a, b, focusTerms, true)))
      if (alignedFreshClaim) {
        domains.add(sources[i].domain)
        domains.add(sources[j].domain)
      }
    }
  }
  return domains
}

/** Evaluate coverage strictly from selected excerpts, never arbitrary page text. */
export function evaluateCoverage(query, goal, sources, newDomainsThisRound = 0) {
  const qTerms = [...new Set(evidenceTerms(query))]
  const gTerms = goalCoverageTerms(goal)
  const coveredTerms = qTerms.filter((term) => evidenceDomainsForTerm(sources, term).size >= 1)
  const coveredGoalTerms = gTerms.filter((term) => evidenceDomainsForTerm(sources, term).size >= 2)
  const goalDomains = new Set()
  for (const term of gTerms) for (const domain of evidenceDomainsForTerm(sources, term)) goalDomains.add(domain)
  const timeSensitiveGoal = isTimeSensitiveGoal(goal ?? query)
  const temporalEvidenceTerms = goal
    ? gTerms
    : qTerms.filter((term) => !TEMPORAL_TERMS.has(term.toLowerCase()))
  const temporalFocusTerms = new Set(temporalEvidenceTerms)
  const freshCoveredTemporalTerms = timeSensitiveGoal
    ? temporalEvidenceTerms.filter((term) => freshAlignedDomainsForTerm(sources, term, temporalFocusTerms).size >= 2)
    : []
  const temporalEvidenceCovered = !timeSensitiveGoal || (
    temporalEvidenceTerms.length > 0 && freshCoveredTemporalTerms.length === temporalEvidenceTerms.length
  )
  const uncoveredGoalTerms = gTerms.filter((term) => !coveredGoalTerms.includes(term))
  const goalEvidenceCovered = !goal
    ? temporalEvidenceCovered
    : gTerms.length > 0 && uncoveredGoalTerms.length === 0 && temporalEvidenceCovered
  const domains = new Set(sources.map((source) => source.domain).filter(Boolean))
  return {
    totalSources: sources.length,
    distinctDomains: domains.size,
    primaryDomains: [...domains].filter((d) => d.endsWith('.gov') || d.endsWith('.edu')),
    coveredTerms,
    uncoveredTerms: qTerms.filter((term) => !coveredTerms.includes(term)),
    goalTerms: gTerms,
    coveredGoalTerms,
    uncoveredGoalTerms,
    goalEvidenceDomains: [...goalDomains].sort(),
    goalEvidenceCovered,
    timeSensitiveGoal,
    semanticGoalCheck: 'not_performed',
    newDomainsThisRound,
  }
}

function initialQueries(query, goal) {
  const target = goal ?? query
  const out = goal ? [query, `${query} ${goal}`] : [query]
  if (isTimeSensitiveGoal(target)) {
    out.push(`${target} ${new Date().getUTCFullYear()} official status`)
  }
  const unique = [...new Set(out)]
  return unique.length > 1 ? unique : undefined
}

export function mergeInitialQueries(query, goal, custom) {
  const defaults = initialQueries(query, goal) ?? []
  if (!custom?.length) return defaults.length > 0 ? defaults : undefined
  // A continuation may target gaps, but it must not remove goal participation.
  const required = goal
    ? [`${query} ${goal}`]
    : (isTimeSensitiveGoal(query) ? defaults.slice(-1) : [])
  return [...new Set([...required, ...custom])]
}

/** Follow-up query suggestions from fetched material. */
export function suggestFollowups(query, titles, newDomains, n = 4) {
  const out = []
  const queryTermsSet = new Set(evidenceTerms(query))
  for (const t of titles) {
    for (const term of distinctiveTerms(t, 2)) {
      if (term.length >= 3 && !queryTermsSet.has(term)) out.push(`${query} ${term}`)
    }
  }
  for (const d of newDomains) {
    if (AUTHORITATIVE_TLDS.some((s) => d.endsWith(s)) || d === 'wikipedia.org') {
      out.push(`site:${d} ${query}`)
    }
  }
  return [...new Set(out)].slice(0, n)
}

/**
 * @typedef {Object} ResearchLoopDeps
 * @property {(opts: { query: string, queries?: string[], maxResults: number, engineList?: string[],
 *   includeDomains?: string[], excludeDomains?: string[], recency?: string, layer?: string|null,
 *   complexity: 'complex', depth: 'advanced', signal?: AbortSignal }) => Promise<{ results: Array<{ title: string, url: string, content?: string }>, engineStats: Record<string, { errors: number, note?: string }> }>} search
 * @property {(url: string, focus: string|undefined, signal?: AbortSignal) => Promise<{ url: string, via: string, content: string, fetched_at?: string, word_count?: number, title?: string }>} fetch
 */

/**
 * Run the loop. `deps.search` is the fused search (runtime.runFused), `deps.fetch`
 * is the page reader (runtime fetchPage bound to its cache).
 * @param {ResearchLoopDeps & { query: string, goal?: string, mode?: 'auto'|'step', maxRounds?: number,
 *   maxSources?: number, perRound?: number, engines?: string[], includeDomains?: string[], excludeDomains?: string[],
 *   recency?: string, layer?: string|null, queries?: string[], signal?: AbortSignal, progress?: (msg: string) => void }} opts
 */
export async function runResearchLoop(opts) {
  const started = Date.now()
  const query = String(opts.query ?? '').trim()
  if (!query) throw new Error('deep_research: query is required')
  const goal = opts.goal
  const focus = goal ? `${query}\n${goal}` : query
  const mode = opts.mode === 'step' ? 'step' : 'auto'
  const maxRounds = plannedResearchRounds(mode, opts.maxRounds)
  const maxSources = Math.min(15, Math.max(1, opts.maxSources ?? 8))
  const perRound = Math.min(6, Math.max(2, opts.perRound ?? 4))
  const progress = opts.progress ?? (() => {})
  const recency = opts.recency && opts.recency !== 'any' ? opts.recency : undefined
  const seenUrls = new Set()
  const seenDomains = new Set()
  /** @type {Array<Record<string, any>>} */
  const sources = []
  const engineStats = {}
  let suggestedQueries = []
  let nextQueries = mergeInitialQueries(query, goal, opts.queries)
  let stopReason = 'max_rounds'
  let rounds = 0
  let newDomainsThisRound = 0
  let stagnantDomainRounds = 0

  for (let round = 1; round <= maxRounds; round++) {
    throwIfAborted(opts.signal)
    rounds = round
    if (maxSources - sources.length <= 0) {
      stopReason = 'source_cap'
      break
    }
    progress(`round ${round}/${maxRounds}: searching (${sources.length}/${maxSources} sources so far)`)
    const fused = await opts.search({
      query: focus,
      queries: nextQueries,
      engineList: opts.engines,
      maxResults: perRound * 3,
      includeDomains: opts.includeDomains,
      excludeDomains: opts.excludeDomains,
      recency,
      layer: opts.layer ?? null,
      complexity: 'complex',
      depth: 'advanced',
      signal: opts.signal,
    })
    for (const [name, stat] of Object.entries(fused.engineStats ?? {})) {
      const acc = (engineStats[name] ??= { errors: 0 })
      acc.errors += stat.errors ?? 0
      if (stat.note && !acc.note) acc.note = stat.note
    }

    const candidates = fused.results.filter((result) => !seenUrls.has(result.url)).slice(0, perRound)
    if (candidates.length === 0) {
      stopReason = 'no_new_results'
      break
    }
    progress(`round ${round}: fetching ${candidates.length} pages`)
    const pages = await pool(candidates, 2, async (hit) => {
      throwIfAborted(opts.signal)
      if (hit.content && countWords(hit.content) >= 300) {
        return {
          title: hit.title,
          url: hit.url,
          domain: hostOf(hit.url),
          via: 'search',
          content: hit.content,
          wordCount: countWords(hit.content),
          fetchedAt: nowIso(),
        }
      }
      try {
        const page = await opts.fetch(hit.url, undefined, opts.signal)
        return {
          title: page.title || hit.title,
          url: page.url || hit.url,
          domain: hostOf(page.url || hit.url),
          via: page.via,
          content: page.content,
          wordCount: page.word_count ?? countWords(page.content),
          fetchedAt: page.fetched_at ?? nowIso(),
        }
      } catch {
        throwIfAborted(opts.signal)
        return null
      }
    })

    newDomainsThisRound = 0
    const roundTitles = []
    const roundDomains = []
    for (let i = 0; i < candidates.length; i++) {
      const page = pages[i]
      if (!page || !page.content) continue
      const hit = candidates[i]
      seenUrls.add(hit.url)
      const domain = page.domain || hostOf(page.url) || hostOf(hit.url)
      if (!seenDomains.has(domain)) {
        seenDomains.add(domain)
        newDomainsThisRound++
        roundDomains.push(domain)
      }
      const excerpts = pickExcerpts(page.content, focus, 3)
      roundTitles.push(page.title || hit.title)
      sources.push({
        title: page.title || hit.title,
        url: page.url,
        domain,
        fetchedAt: page.fetchedAt,
        via: page.via,
        wordCount: page.wordCount,
        excerpt: excerpts.join(' ... '),
        corroboratedBy: [],
        freshCorroboratedBy: [],
      })
      if (sources.length >= maxSources) break
    }

    stagnantDomainRounds = newDomainsThisRound === 0 ? stagnantDomainRounds + 1 : 0
    applyCorroboration(sources, focus, isTimeSensitiveGoal(goal ?? query))
    const coverage = evaluateCoverage(query, goal, sources, newDomainsThisRound)
    const gaps = [...coverage.uncoveredTerms, ...coverage.uncoveredGoalTerms]
    const followups = suggestFollowups(focus, roundTitles, roundDomains, 4)
    if (gaps.length > 0) followups.unshift(`${query} ${gaps.join(' ')} evidence`)
    if (coverage.timeSensitiveGoal && goal) {
      followups.unshift(`${goal} ${new Date().getUTCFullYear()} official status`)
    }
    suggestedQueries = [...new Set(followups.map((q) => q.trim()).filter(Boolean))].slice(0, 4)
    if (suggestedQueries.length > 0) {
      nextQueries = suggestedQueries
      if (round < maxRounds && mode !== 'step') {
        progress(`round ${round}: evidence gaps -> ${suggestedQueries.join(' | ')}`)
      }
    }

    if (mode === 'step') {
      stopReason = 'step'
      break
    }
    if (sources.length >= maxSources) {
      stopReason = 'source_cap'
      break
    }
    if (stagnantDomainRounds >= 2) {
      stopReason = 'no_new_domains_two_rounds'
      break
    }
    const queryCovered = coverage.uncoveredTerms.length === 0
    if (queryCovered && coverage.goalEvidenceCovered && sources.length >= Math.min(3, maxSources)) {
      stopReason = goal ? 'goal_evidence_covered' : 'query_evidence_covered'
      break
    }
    if (suggestedQueries.length === 0) {
      stopReason = 'no_followups'
      break
    }
  }

  applyCorroboration(sources, focus, isTimeSensitiveGoal(goal ?? query))
  const coverage = evaluateCoverage(query, goal, sources, newDomainsThisRound)
  return {
    query,
    goal,
    rounds,
    mode,
    stopReason,
    sources,
    coverage,
    suggestedQueries,
    engineStats,
    tookMs: Date.now() - started,
    finishedAt: nowIso(),
    corroborationMethod: 'claim-segment lexical alignment plus exact version/date/measure anchors; heuristic, not proof',
  }
}
