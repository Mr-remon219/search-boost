/** Recognize observed platform error/landing pages, not general security discussion. */
export function unavailableCommunityContent(platform, value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (platform === 'xiaohongshu') return /^(?:小红书\s*[-—–:]\s*)?(?:你访问的页面不见了|安全限制(?:\s|$)|Account abnormal\. Switch|页面不存在(?:\s|$))/i.test(text)
  if (platform === 'zhihu') return /^(?:知乎，让每一次点击都充满意义\s*[—–-]*\s*欢迎来到知乎，发现问题背后的世界[。.]?|请开启 JavaScript 并刷新该页面|您似乎来到了没有知识存在的荒原)[。.!\s]*$/.test(text)
  if (platform === 'bilibili') return /^(?:访问受限|请求被拦截|页面不存在|视频不见了)(?:\s|[。.!]|$)/.test(text)
  return false
}

/** Keep a usable engine excerpt when another engine indexed the same error page. */
export function cleanCommunityHit(platform, row) {
  if (!row || typeof row !== 'object') return null
  const excerpt = row?.snippet ?? row?.description ?? row?.text ?? ''
  const entries = Array.isArray(row?.provenance) ? row.provenance : []
  const valid = entries.filter(entry => !unavailableCommunityContent(platform, entry.snippet))
  const bad = entries.filter(entry => unavailableCommunityContent(platform, entry.snippet))
  if (!bad.length && !unavailableCommunityContent(platform, excerpt)) return row
  const replacement = valid.find(entry => typeof entry.snippet === 'string' && entry.snippet.trim())
  if (unavailableCommunityContent(platform, excerpt) && !replacement) return null
  const ranks = { ...(row.engineRanks ?? {}) }
  for (const entry of bad) if (!valid.some(other => other.engine === entry.engine)) delete ranks[entry.engine]
  return { ...row, ...(unavailableCommunityContent(platform, excerpt) ? { snippet: replacement.snippet, text: replacement.snippet, published: replacement.published ?? null } : {}),
    engineRanks: ranks, ...(row.engines ? { engines: row.engines.filter(engine => Object.hasOwn(ranks, engine)) } : {}), provenance: valid }
}
