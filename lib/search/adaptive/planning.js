// Query generation is deterministic. Jev chooses among these bounded variants;
// it never pretends to generate free-form text through the typed decision API.
import { choice } from '../../jev/questions.js'
import { resultKey, hostOf } from '../results.js'
import { explicitTokens } from './prompts.js'

export function queryCandidates(question, gap = 'fact') {
  const anchor = question.context || question.text
  const variants = question.keywords?.length
    ? question.keywords.map((keyword) => `${anchor} ${keyword}`)
    : [question.text]
  // Preserve explicit versions and dates from the acceptance question, even if
  // the caller supplied a compact context with only the product name.
  const requirements = [...new Set([...(question.text.match(/\b(?:v?\d+\.\d+(?:\.\d+)*|\d{4}-\d{2}-\d{2})\b/g) ?? []), ...explicitTokens(question.text)])]
  const suffix = { official: 'official announcement documentation', date: 'publication date announcement', region: question.acceptance || question.text, independent: 'independent report evidence', fact: question.acceptance || question.text }[gap] ?? ''
  if (suffix && suffix !== anchor) variants.push(`${anchor} ${suffix}`)
  if (question.timeWindow) {
    requirements.push(question.timeWindow.start)
    if (question.timeWindow.end !== question.timeWindow.start) requirements.push(question.timeWindow.end)
  }
  return [...new Set(variants.map((query) => {
    let value = query.replace(/\s+/g, ' ').trim()
    for (const token of requirements) if (!value.includes(token)) value += ` ${token}`
    return value
  }))].map((query, i) => ({ key: `v${i + 1}`, query }))
}

export function addQueryChoices(request, questions, candidatesById) {
  request.state.query_options = questions.map((q) => ({ question_id: q.id, options: candidatesById[q.id] ?? [] }))
  for (const [i, q] of questions.entries()) {
    const variants = candidatesById[q.id] ?? []
    if (variants.length < 2) continue
    request.questions[`query.${q.id}`] = choice(
      `Which query in state.query_options[${i}].options will best fill the remaining gap for target ${q.id}? Read the target and feedback in state, not just the keyword.`,
      Object.fromEntries(variants.map((v, j) => [v.key, `Use state.query_options[${i}].options[${j}].query`])),
    )
  }
}

/** Reserve candidate opportunities for every chosen engine before fusion can
 * crowd them out. Per-engine rank, not preset weight, drives each lane. */
export function selectEngineCandidates(rows, engines, limit, { minScore = 0 } = {}) {
  const queues = engines.map((engine) => rows.filter((row) => row.engines.includes(engine) && row.score >= minScore)
    .sort((a, b) => (a.engineRanks?.[engine] ?? Infinity) - (b.engineRanks?.[engine] ?? Infinity)))
  const seen = new Set(), results = [], domains = new Map()
  // First prefer domain diversity; then fill unused slots rather than discarding
  // useful same-domain official documentation when there are no alternatives.
  for (const cap of [2, Infinity]) {
    while (results.length < limit) {
      let added = false
      for (const queue of queues) {
        const index = queue.findIndex((row) => !seen.has(resultKey(row)) && (domains.get(hostOf(row.url)) ?? 0) < cap)
        if (index < 0) continue
        const [row] = queue.splice(index, 1)
        seen.add(resultKey(row))
        const domain = hostOf(row.url)
        domains.set(domain, (domains.get(domain) ?? 0) + 1)
        results.push(row)
        added = true
        if (results.length === limit) break
      }
      if (!added) break
    }
  }
  return { results, truncated: results.length < rows.length }
}
