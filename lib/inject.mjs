export const MARKER_START = '<!-- SEARCH_BOOST_START -->'
export const MARKER_END = '<!-- SEARCH_BOOST_END -->'

/** @param {string} existing @param {string} snippet */
export function injectBlock(existing, snippet) {
  const block = `${MARKER_START}\n${snippet.trim()}\n${MARKER_END}`
  if (existing.includes(MARKER_START)) {
    const before = existing.slice(0, existing.indexOf(MARKER_START))
    const after = existing.slice(existing.indexOf(MARKER_END) + MARKER_END.length)
    return `${before}${block}${after}`.replace(/\n{3,}/g, '\n\n').trim() + '\n'
  }
  const header = existing.trim() ? `${existing.trim()}\n\n` : ''
  return `${header}${block}\n`
}

/** @param {string} existing */
export function removeBlock(existing) {
  if (!existing.includes(MARKER_START)) return existing
  const before = existing.slice(0, existing.indexOf(MARKER_START))
  const after = existing.slice(existing.indexOf(MARKER_END) + MARKER_END.length)
  const out = `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim()
  return out ? `${out}\n` : ''
}

/** @param {string} existing @param {string} sectionName @param {string} body */
export function injectTomlSection(existing, sectionName, body) {
  const start = `# SEARCH_BOOST_${sectionName}_START`
  const end = `# SEARCH_BOOST_${sectionName}_END`
  const block = `${start}\n${body.trim()}\n${end}`
  if (existing.includes(start)) {
    const before = existing.slice(0, existing.indexOf(start))
    const after = existing.slice(existing.indexOf(end) + end.length)
    return `${before}${block}${after}`.replace(/\n{3,}/g, '\n\n').trim() + '\n'
  }
  return `${existing.trim()}\n\n${block}\n`
}

/** @param {string} existing @param {string} sectionName */
export function removeTomlSection(existing, sectionName) {
  const start = `# SEARCH_BOOST_${sectionName}_START`
  const end = `# SEARCH_BOOST_${sectionName}_END`
  if (!existing.includes(start)) return existing
  const before = existing.slice(0, existing.indexOf(start))
  const after = existing.slice(existing.indexOf(end) + end.length)
  const out = `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim()
  return out ? `${out}\n` : ''
}