export const MARKER_START = '<!-- SEARCH_BOOST_START -->'
export const MARKER_END = '<!-- SEARCH_BOOST_END -->'
export const GEMINI_MARKER_START = '<!-- SEARCH_BOOST_GEMINI_START -->'
export const GEMINI_MARKER_END = '<!-- SEARCH_BOOST_GEMINI_END -->'

/**
 * @param {string} existing
 * @param {string} start
 * @param {string} end
 * @param {string} body
 */
export function injectMarked(existing, start, end, body) {
  const block = `${start}\n${body.trim()}\n${end}`
  if (existing.includes(start)) {
    const before = existing.slice(0, existing.indexOf(start))
    const after = existing.slice(existing.indexOf(end) + end.length)
    return `${before}${block}${after}`.replace(/\n{3,}/g, '\n\n').trim() + '\n'
  }
  const header = existing.trim() ? `${existing.trim()}\n\n` : ''
  return `${header}${block}\n`
}

/** @param {string} existing @param {string} start @param {string} end */
export function removeMarked(existing, start, end) {
  if (!existing.includes(start)) return existing
  const before = existing.slice(0, existing.indexOf(start))
  const after = existing.slice(existing.indexOf(end) + end.length)
  const out = `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim()
  return out ? `${out}\n` : ''
}

/** @param {string} existing @param {string} snippet */
export function injectBlock(existing, snippet) {
  return injectMarked(existing, MARKER_START, MARKER_END, snippet)
}

/** @param {string} existing */
export function removeBlock(existing) {
  return removeMarked(existing, MARKER_START, MARKER_END)
}

/** @param {string} existing @param {string} snippet */
export function injectGeminiBlock(existing, snippet) {
  return injectMarked(existing, GEMINI_MARKER_START, GEMINI_MARKER_END, snippet)
}

/** @param {string} existing */
export function removeGeminiBlock(existing) {
  return removeMarked(existing, GEMINI_MARKER_START, GEMINI_MARKER_END)
}

/** @param {string} existing @param {string} sectionName @param {string} body */
export function injectTomlSection(existing, sectionName, body) {
  return injectMarked(
    existing,
    `# SEARCH_BOOST_${sectionName}_START`,
    `# SEARCH_BOOST_${sectionName}_END`,
    body,
  )
}

/** @param {string} existing @param {string} sectionName */
export function removeTomlSection(existing, sectionName) {
  return removeMarked(
    existing,
    `# SEARCH_BOOST_${sectionName}_START`,
    `# SEARCH_BOOST_${sectionName}_END`,
  )
}
