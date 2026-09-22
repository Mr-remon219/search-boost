// Compact wire format: a canonical URL occurs once per request. Associations
// reference a source and an exact fragment, never borrow another target's text.
import { resultKey } from '../results.js'

export function packMaterial(items) {
  const sources = []
  const byKey = new Map()
  const references = items.map((item) => {
    const key = resultKey(item)
    let si = byKey.get(key)
    if (si === undefined) {
      si = sources.length
      byKey.set(key, si)
      sources.push({ id: item.sourceId ?? `s${si + 1}`, url: item.url, title: item.title, domain: item.domain, published: item.published ?? null, fragments: [] })
    }
    const source = sources[si]
    let fi = source.fragments.findIndex((f) => f.text === item.text && f.text_basis === item.basis)
    if (fi < 0) {
      fi = source.fragments.length
      source.fragments.push({ text: item.text, text_basis: item.basis, text_version: item.textVersion ?? null })
    }
    return { id: item.evidenceId, for_question: item.questionId, source_index: si, fragment_index: fi, text_basis: item.basis }
  })
  return { sources, references }
}

export function materialPath(ref) {
  return `state.sources[${ref.source_index}].fragments[${ref.fragment_index}].text`
}

export function requestFits(request, limits) {
  return JSON.stringify(request.state).length <= limits.maxStateChars
    // Reserve space for model and SDK envelope; never size only the evidence.
    && JSON.stringify({ state: request.state, questions: request.questions }).length + 1024 <= limits.maxRequestChars
}
