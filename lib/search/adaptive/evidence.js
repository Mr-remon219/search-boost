// In-memory evidence pool for one adaptive_search call.
//
// The pool separates two things that are easy to conflate:
//   * a SOURCE (one URL: title/domain/published/engines/fusion score)
//   * an ASSOCIATION (question × source: the reviewed fragment, its text basis,
//     its version, and the judgements made about exactly that text)
//
// Sharing a URL between questions never shares a relevance conclusion: each
// association is judged on its own fragment for its own question. Objects
// returned by the core caches are read-only here — every record is a copy.
//
// Text basis ranking is fetched_page > engine_content > snippet. A failed,
// empty or worse fragment never overwrites useful existing text, and changing
// a basis label alone is not progress: only new/changed material text is.

import { createHash } from 'node:crypto'
import { excerptForTool, pickParagraphs } from '../evidence.js'
import { collapseSpace, hostOf, resultKey } from '../results.js'
import { countWords } from '../text.js'
import { ADAPTIVE_LIMITS } from './limits.js'

export const TEXT_BASIS_RANK = { snippet: 1, engine_content: 2, fetched_page: 3 }
export const TEXT_BASIS_ORDER = ['fetched_page', 'engine_content', 'snippet']

export function isMaterialText(text, limits = ADAPTIVE_LIMITS) {
  return countWords(collapseSpace(text)) >= limits.minMaterialWords
}

/** Version tag for the exact reviewed text + basis: judgements are bound to it. */
export function textVersionOf(text, basis) {
  if (!text || !basis) return null
  return `${basis}:${createHash('sha1').update(text).digest('hex').slice(0, 10)}`
}

/** Bounded fragments for one question from a longer page body. */
export function excerptForContent(content, questionText, limits = ADAPTIVE_LIMITS) {
  if (!isMaterialText(content, limits)) return { text: '', basis: null }
  const picked = pickParagraphs(content, questionText, limits.maxExcerptsPerEvidence, limits.maxExcerptChars)
  const pieces = []
  let used = 0
  for (const raw of picked.length ? picked : [excerptForTool(content, limits.maxExcerptChars)]) {
    const piece = String(raw ?? '').trim().slice(0, Math.max(limits.maxExcerptChars, 0))
    if (!piece) continue
    if (used + piece.length > limits.maxEvidenceTextChars) break
    pieces.push(piece)
    used += piece.length + 2
  }
  const text = pieces.join('\n\n').trim()
  if (!isMaterialText(text, limits)) return { text: '', basis: null }
  return { text, basis: 'engine_content' }
}

/**
 * @param {{ limits?: typeof ADAPTIVE_LIMITS, questions: Array<{ id: string, text: string }> }} config
 */
export function createEvidencePool(config) {
  const limits = config.limits ?? ADAPTIVE_LIMITS
  const questions = new Map(config.questions.map((q) => [q.id, q.text]))
  const questionOfText = new Map(config.questions.map((q) => [q.id, q.text]))

  /** @type {Map<string, any>} */
  const sources = new Map()
  /** @type {Map<string, any>} */
  const associations = new Map()
  /** @type {Map<string, string[]>} */
  const byQuestion = new Map(config.questions.map((q) => [q.id, []]))
  let nextEvidenceNumber = 1
  let droppedAssociations = 0
  const warnings = []

  const assocKeyOf = (questionId, sourceKey) => `${questionId}\u0000${sourceKey}`

  function warn(message) {
    if (warnings.includes(message)) return
    if (warnings.length >= 20) return
    warnings.push(message)
  }

  function upsertSource(hit) {
    const key = resultKey(hit)
    if (!key) return null
    let source = sources.get(key)
    if (!source) {
      source = {
        key,
        // Display URL: first seen wins (stable, tracking params kept as returned).
        url: String(hit.url),
        displayUrl: String(hit.url),
        domain: hit.domain ?? hostOf(hit.url),
        title: String(hit.title ?? ''),
        published: hit.published ?? null,
        engines: new Set(),
        fusionScore: null,
        fetch: null,
      }
      sources.set(key, source)
    }
    if (!source.title && hit.title) source.title = String(hit.title)
    if (!source.published && hit.published) source.published = hit.published
    for (const engine of hit.engines ?? []) source.engines.add(engine)
    if (typeof hit.score === 'number' && Number.isFinite(hit.score)) {
      source.fusionScore = source.fusionScore === null ? hit.score : Math.max(source.fusionScore, hit.score)
    }
    return source
  }

  function bestAvailableText(source, questionText) {
    // A fetched page is the best material we can hold for this question; then
    // engine content; the engine snippet is the last resort.
    const fetched = source.fetch?.text
    if (fetched && isMaterialText(fetched, limits)) return { text: fetched, basis: 'fetched_page' }
    const content = source.engineContent?.text
    if (content && isMaterialText(content, limits)) return { text: content, basis: 'engine_content' }
    const snippet = source.snippet?.text
    if (snippet && isMaterialText(snippet, limits)) return { text: snippet, basis: 'snippet' }
    return { text: '', basis: null }
  }

  function shouldReplace(assoc, candidate) {
    if (!candidate.text) return false
    if (!assoc.text) return true
    const currentRank = TEXT_BASIS_RANK[assoc.basis] ?? 0
    const nextRank = TEXT_BASIS_RANK[candidate.basis] ?? 0
    if (nextRank > currentRank) return true
    if (nextRank < currentRank) return false
    // Same basis: only a strictly more informative fragment (more words) counts
    // as new material. Rewriting an equal/smaller fragment would churn versions
    // and fake progress.
    return countWords(candidate.text) > countWords(assoc.text)
  }

  function touchAssociation(assoc, { round, origin, changed }) {
    if (changed) {
      assoc.textVersion = textVersionOf(assoc.text, assoc.basis)
      assoc.judgment = null
      assoc.coverage = null
      assoc.changedAtRound = round
      assoc.changeCount++
    }
    if (origin === 'fetch' && assoc.origin !== 'fetch') assoc.origin = 'fetch'
    if (round !== undefined) assoc.lastTouchedRound = round
    assoc.pendingJudgment = Boolean(assoc.text) && assoc.judgmentVersion !== assoc.textVersion
  }

  return {
    limits,
    warnings,
    size: () => associations.size,
    sourceCount: () => sources.size,
    droppedAssociations: () => droppedAssociations,
    warningsList: () => [...warnings],

    /** URLs collected for a question (fetch actions may only use these). */
    urlsFor(questionId) {
      const out = []
      for (const assocKey of byQuestion.get(questionId) ?? []) {
        const assoc = associations.get(assocKey)
        const source = sources.get(assoc.sourceKey)
        if (source?.fetch?.state === 'ok' && source.fetch.basisUrl === source.key) continue
        out.push({ sourceKey: assoc.sourceKey, url: source?.displayUrl ?? source?.url, evidenceId: assoc.id, basis: assoc.basis, score: assoc.fusionScore ?? 0 })
      }
      return out
    },

    /**
     * Fold one question's fused-search results into the pool.
     * @param {{ questionId: string, round: number, results: any[] }} input
     */
    ingestSearch({ questionId, round, results }) {
      const questionText = questionOfText.get(questionId) ?? ''
      const created = []
      const changed = []
      let textless = 0
      for (const hit of results ?? []) {
        const source = upsertSource(hit)
        if (!source) continue
        if (typeof hit.snippet === 'string' && collapseSpace(hit.snippet).length > 0) {
          const text = collapseSpace(hit.snippet).slice(0, limits.maxExcerptChars)
          if (!source.snippet || countWords(text) > countWords(source.snippet.text)) source.snippet = { text }
        }
        if (typeof hit.content === 'string' && collapseSpace(hit.content).length > 0) {
          const picked = excerptForContent(hit.content, questionText, limits)
          if (picked.text && (!source.engineContent || countWords(picked.text) > countWords(source.engineContent.text))) {
            source.engineContent = { text: picked.text }
          }
        }
        const assocKey = assocKeyOf(questionId, source.key)
        let assoc = associations.get(assocKey)
        const candidate = bestAvailableText(source, questionText)
        if (!assoc) {
          if (associations.size >= limits.maxEvidenceItems) {
            droppedAssociations++
            warn(`evidence pool reached its ${limits.maxEvidenceItems}-item cap; further results were not tracked`)
            continue
          }
          assoc = {
            id: `e${nextEvidenceNumber++}`,
            assocKey,
            questionId,
            sourceKey: source.key,
            text: '',
            basis: null,
            textVersion: null,
            fusionScore: hit.score ?? source.fusionScore ?? 0,
            engines: [...(hit.engines ?? [])],
            round,
            origin: 'search',
            changeCount: 0,
            judgment: null,
            judgmentVersion: null,
            coverage: null,
            lastTouchedRound: round,
            pendingJudgment: false,
          }
          associations.set(assocKey, assoc)
          byQuestion.get(questionId)?.push(assocKey)
          if (candidate.text) {
            assoc.text = candidate.text
            assoc.basis = candidate.basis
            touchAssociation(assoc, { round, origin: 'search', changed: true })
          } else {
            assoc.pendingJudgment = false
          }
          created.push(assoc)
          if (!assoc.text) textless++
          else changed.push(assoc)
          continue
        }
        for (const engine of hit.engines ?? []) if (!assoc.engines.includes(engine)) assoc.engines.push(engine)
        if (typeof hit.score === 'number' && Number.isFinite(hit.score)) assoc.fusionScore = Math.max(assoc.fusionScore ?? 0, hit.score)
        if (shouldReplace(assoc, candidate)) {
          assoc.text = candidate.text
          assoc.basis = candidate.basis
          touchAssociation(assoc, { round, origin: 'search', changed: true })
          changed.push(assoc)
        } else {
          touchAssociation(assoc, { round, origin: assoc.origin, changed: false })
          if (!assoc.text) textless++
        }
      }
      return { created, changed, textless }
    },

    /**
     * Fold a fetched page into one association. Only material text replaces
     * existing material; an empty/error page never overwrites a good fragment.
     * @param {{ questionId: string, sourceKey: string, page: any, round: number, focusMiss?: boolean }} input
     */
    ingestFetch({ questionId, sourceKey, page, round, focusMiss = false }) {
      const source = sources.get(sourceKey)
      if (!source) return { changed: false, reason: 'unknown_source' }
      const questionText = questionOfText.get(questionId) ?? ''
      const body = collapseSpace(page?.content ?? '')
      const picked = isMaterialText(body, limits)
        ? excerptForContent(body, questionText, limits)
        : { text: '', basis: null }
      const text = picked.text
      if (!text) {
        source.fetch = { state: 'empty', via: page?.via ?? null, words: page?.word_count ?? 0, focusMiss, atRound: round }
        return { changed: false, reason: focusMiss ? 'fetch_focus_miss' : 'fetch_no_text' }
      }
      const previous = source.fetch?.words ?? 0
      source.fetch = { state: 'ok', via: page?.via ?? null, words: page?.word_count ?? 0, focusMiss, atRound: round, text, basisUrl: source.key }
      const assocKey = assocKeyOf(questionId, sourceKey)
      const assoc = associations.get(assocKey)
      if (!assoc) return { changed: false, reason: 'unknown_association', text }
      const candidate = { text, basis: 'fetched_page' }
      if (!shouldReplace(assoc, candidate) && previous > 0 && assoc.basis === 'fetched_page') {
        touchAssociation(assoc, { round, origin: 'fetch', changed: false })
        return { changed: false, reason: 'fetch_not_better' }
      }
      if (!shouldReplace(assoc, candidate)) {
        // Keep the earlier, better fragment (an equal/smaller fetch adds nothing).
        assoc.origin = 'fetch'
        touchAssociation(assoc, { round, origin: 'fetch', changed: false })
        return { changed: false, reason: 'fetch_not_better' }
      }
      assoc.text = candidate.text
      assoc.basis = candidate.basis
      touchAssociation(assoc, { round, origin: 'fetch', changed: true })
      return { changed: true, reason: 'fetched_page', text }
    },

    /** Associations still needing a judgement at their current text version. */
    pendingSourceJudge() {
      const out = []
      for (const assoc of associations.values()) {
        if (!assoc.text || !assoc.textVersion) continue
        if (assoc.judgmentVersion === assoc.textVersion && assoc.judgment) continue
        const source = sources.get(assoc.sourceKey)
        out.push({
          assocId: assoc.assocKey,
          evidenceId: assoc.id,
          questionId: assoc.questionId,
          sourceKey: assoc.sourceKey,
          url: source?.displayUrl ?? source?.url ?? '',
          title: source?.title ?? '',
          domain: source?.domain ?? '',
          published: source?.published ?? null,
          engines: [...assoc.engines],
          fusionScore: assoc.fusionScore,
          text: assoc.text,
          basis: assoc.basis,
          textVersion: assoc.textVersion,
        })
      }
      return out.sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0) || a.evidenceId.localeCompare(b.evidenceId))
    },

    /**
     * Store judgements for exactly the text version they were made about. A
     * judgement for an older version is rejected, so changed text is never
     * certified by a stale answer.
     * @param {Array<{ assocId: string, textVersion: string, scores: Record<string, number|null>, round: number }>} judgments
     */
    applySourceJudgments(judgments) {
      let applied = 0
      let stale = 0
      for (const item of judgments) {
        const assoc = associations.get(item.assocId)
        if (!assoc) continue
        if (assoc.textVersion !== item.textVersion) {
          stale++
          continue
        }
        assoc.judgment = { ...item.scores, round: item.round }
        assoc.judgmentVersion = item.textVersion
        assoc.pendingJudgment = false
        applied++
      }
      return { applied, stale }
    },

    association: (assocKey) => associations.get(assocKey),
    source: (sourceKey) => sources.get(sourceKey),
    associationsFor: (questionId) => (byQuestion.get(questionId) ?? []).map((key) => associations.get(key)).filter(Boolean),

    /** Ordered, deduplicated qualified-set signature: the exact text versions judged. */
    versionSignature(questionId, assocIds) {
      const ids = [...new Set(assocIds)].sort()
      const parts = ids.map((key) => {
        const assoc = associations.get(key)
        return `${assoc?.id}@${assoc?.textVersion}`
      })
      return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)
    },

    setCoverage(questionId, verdict) {
      for (const assoc of this.associationsFor(questionId)) if (assoc.coverage) assoc.coverage = null
      for (const assocKey of verdict.assocKeys ?? []) {
        const assoc = associations.get(assocKey)
        if (assoc) assoc.coverage = { versionSignature: verdict.versionSignature, verdictAtRound: verdict.round }
      }
    },

    coverageOf(questionId) {
      const list = this.associationsFor(questionId)
      const withCoverage = list.filter((assoc) => assoc.coverage)
      if (!withCoverage.length) return null
      return { versionSignature: withCoverage[0].coverage.versionSignature, verdictAtRound: withCoverage[0].coverage.verdictAtRound }
    },

    stats: () => ({
      sources: sources.size,
      associations: associations.size,
      withText: [...associations.values()].filter((assoc) => Boolean(assoc.text)).length,
      answerCapable: [...associations.values()].filter((assoc) => assoc.judgment?.answer_capable).length,
      droppedAssociations,
    }),
  }
}
