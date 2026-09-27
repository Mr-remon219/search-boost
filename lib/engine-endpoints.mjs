/** API bases, not full search endpoints. Prefixes are preserved when appending paths. */
export const ENGINE_BASE_URLS = Object.freeze({
  tavily: 'https://api.tavily.com',
  brave: 'https://api.search.brave.com/res/v1',
  exa: 'https://api.exa.ai',
  anysearch: 'https://api.anysearch.com/v1',
})
export const ENGINE_SEARCH_PATHS = Object.freeze({ tavily: '/search', brave: '/web/search', exa: '/search', anysearch: '/search' })

export function normalizeEngineBaseUrl(value) {
  const message = 'Base URL must be an absolute HTTP(S) URL without credentials, query or fragment'
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) throw new Error(message)
  let url
  try { url = new URL(value.trim()) } catch { throw new Error(message) }
  if (!url.hostname || url.username || url.password || url.search || url.hash || /[?#\\\s]/.test(value.trim())) throw new Error(message)
  return url.href.replace(/\/+$/, '')
}

export function engineSearchUrl(name, bases = {}) {
  return normalizeEngineBaseUrl(bases[name] ?? ENGINE_BASE_URLS[name]) + ENGINE_SEARCH_PATHS[name]
}
