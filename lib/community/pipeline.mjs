import { COMMUNITY_SEARCH_INPUT, validateCommunity } from './schemas.mjs'
import { createXPipeline } from '../search/x/x-pipeline.js'
import { platformUrl } from './selection.mjs'
import { xIdentity } from '../search/results.js'
import { projectVideoBlock } from './bilibili-block.mjs'
import { communityDate } from './dates.mjs'
import { projectDiscussion } from './discussion.mjs'

const X_FIELDS = ['username', 'post_id', 'allowed_x_handles', 'excluded_x_handles', 'model', 'reasoning_effort']
const REDDIT_FIELDS = ['subreddits', 'max_pages']
const MODES = ['keyword', 'semantic', 'user', 'thread']
const present = value => value !== undefined && value !== null
const pick = (local, common, key) => present(local[key]) ? local[key] : present(common[key]) ? common[key] : undefined

export { communityDate } from './dates.mjs'
/** Publication precision is an interval, never an invented midnight instant. */
function publicationWindow(value) {
  try {
    if (typeof value !== 'string' || !value) return null
    return { from: communityDate(value), to: communityDate(value, true) }
  } catch { return null }
}
function authors(values) {
  if (!present(values)) return undefined
  if (values.some(value => !/^[a-z0-9_-]{1,64}$/i.test(value))) throw new Error('Reddit author filters require username identities, not display names or URLs')
  return [...new Set(values.map(value => value.toLowerCase()))]
}
export function normalizeCommunityInput(input) {
  validateCommunity(COMMUNITY_SEARCH_INPUT, input)
  const cursor = input.cursor !== undefined, saved = input.saved_result_id !== undefined
  if (cursor || saved) {
    if (cursor && saved || Object.keys(input).some(key => !['cursor', 'saved_result_id', 'page_size'].includes(key))) throw new Error('Community snapshot reads accept cursor OR saved_result_id and page_size only; no search was performed')
    return { mode: cursor ? 'cursor' : 'saved', cursor: input.cursor, savedResultId: input.saved_result_id, pageSize: input.page_size ?? 5 }
  }
  if (!input.engines?.length) throw new Error('Selected community engines required')
  const platformOptions = input.platform_options ?? {}
  if (Object.keys(platformOptions).some(platform => !input.engines.includes(platform))) throw new Error('platform_options must refer to selected platforms only')
  if (!input.engines.includes('x') && X_FIELDS.some(key => input[key] !== undefined)) throw new Error('X-only fields require the X platform')
  if (!input.engines.includes('reddit') && REDDIT_FIELDS.some(key => input[key] !== undefined)) throw new Error('Reddit-only fields require the Reddit platform')
  // Validate common dates even when every platform overrides them.
  const commonFrom = communityDate(input.from_date), commonTo = communityDate(input.to_date, true)
  if (commonFrom !== null && commonTo !== null && commonFrom > commonTo) throw new Error('from_date must not exceed to_date')
  const limit = input.max_results ?? 5
  const requests = input.engines.map(platform => {
    const local = platformOptions[platform] ?? {}
    const args = { type: pick(local, input, 'type') ?? 'keyword', max_results: limit }
    for (const key of ['query', 'from_date', 'to_date', ...(platform === 'x' ? X_FIELDS : platform === 'reddit' ? REDDIT_FIELDS : platform === 'bilibili' ? ['note_limit', 'comment_limit'] : [])]) {
      const value = pick(local, input, key)
      if (value !== undefined) args[key] = value
    }
    if (typeof args.query === 'string') args.query = args.query.trim()
    const from = communityDate(args.from_date), to = communityDate(args.to_date, true)
    if (from !== null && to !== null && from > to) throw new Error('from_date must not exceed to_date')
    if (!MODES.includes(args.type)) throw new Error('Unknown community operation')
    if (platform === 'x') {
      if (args.type === 'user' && !String(args.username ?? args.query ?? '').trim()) throw new Error('X account required')
      if (args.type === 'thread' && !args.post_id?.trim()) throw new Error('X post_id required')
      if (args.type !== 'thread' && args.post_id !== undefined) throw new Error('post_id requires thread mode')
      // X keyword username is a verified author constraint, not user mode only.
      const pipeline = createXPipeline(args, limit)
      Object.assign(args, pipeline.params)
      if (args.type === 'keyword' && !args.query && args.username) args.query = `from:${args.username}`
    }
    if (['keyword', 'semantic'].includes(args.type) && !args.query) throw new Error('Search query required')
    const filters = { from, to, contentType: local.content_type ?? null }
    if (platform === 'reddit') {
      filters.allowedAuthors = authors(local.allowed_authors)
      filters.excludedAuthors = authors(local.excluded_authors)
      if (filters.allowedAuthors?.length && filters.excludedAuthors?.length) throw new Error('allowed_authors and excluded_authors are mutually exclusive')
      // Archive acquisition is day-bounded; exact timestamp verification follows.
      if (from !== null) args.from_date = new Date(from).toISOString().slice(0, 10)
      if (to !== null) args.to_date = new Date(to).toISOString().slice(0, 10)
    }
    return { platform, args, filters }
  })
  return { mode: 'new', platforms: [...input.engines], requests, limit, pageSize: input.page_size ?? 5, saveResults: input.save_results ?? false }
}

export function platformContentType(platform, url, type = 'keyword') {
  if (platform === 'x') return type === 'user' ? 'account' : 'post'
  if (platform === 'reddit') return 'post'
  const path = new URL(url).pathname
  if (platform === 'bilibili') return path.startsWith('/video/') ? 'video' : path.startsWith('/read/') ? 'article' : 'post'
  if (platform === 'zhihu') return path.startsWith('/p/') ? 'article' : /\/answer\/\d+/.test(path) ? 'answer' : 'question'
  return 'note'
}
export function platformIdentityKey(platform, url, category) {
  const path = new URL(url).pathname
  const id = platform === 'x' ? xIdentity(url).id ?? xIdentity(url).username
    : platform === 'reddit' ? /\/comments\/([a-z0-9]+)/i.exec(path)?.[1]?.toLowerCase()
      : platform === 'bilibili' ? /\/(?:video|read|opus)\/([^/]+)/.exec(path)?.[1]
        : platform === 'zhihu' ? /\/answer\/(\d+)/.exec(path)?.[1] ?? /\/(?:question|p)\/(\d+)/.exec(path)?.[1]
          : /\/(?:explore|discovery\/item)\/([^/]+)/.exec(path)?.[1]
  return `${platform}:${category}:${id ?? url}`
}
function publicProvenance(entries, platform) {
  return (Array.isArray(entries) ? entries : []).flatMap(entry => {
    if (!entry || typeof entry.engine !== 'string' || !Number.isSafeInteger(entry.rank) || entry.rank < 1) return []
    const out = { engine: entry.engine, rank: entry.rank }
    for (const key of ['title', 'snippet', 'published', 'platform', 'provider', 'backend', 'retrieval_mode', 'content_type']) if (typeof entry[key] === 'string' || entry[key] === null) out[key] = entry[key]
    const url = platformUrl(platform, entry.url)
    if (url) out.url = url
    return [out]
  })
}
/** Provider-specific fields survive under typed data, never arbitrary raw responses/config. */
export function platformData(platform, item, category) {
  const data = { schema_version: 1, platform, kind: category }
  const fields = platform === 'x' ? ['id', 'username', 'author', 'text', 'created_at', 'likes', 'reposts', 'replies', 'views', 'lang', 'media', 'in_reply_to', 'name', 'bio', 'followers', 'following', 'verified', 'recent_posts']
    : platform === 'reddit' ? ['id', 'subreddit', 'author', 'text', 'created_utc', 'retrieved_on'] : ['author', 'title', 'text', 'published']
  for (const key of fields) if (item[key] !== undefined) data[key] = structuredClone(item[key])
  const path = new URL(item.url).pathname
  if (platform === 'bilibili') data.content_id = /\/(?:video|read|opus)\/([^/]+)/.exec(path)?.[1] ?? null
  if (platform === 'zhihu') { data.question_id = /\/question\/(\d+)/.exec(path)?.[1] ?? null; data.answer_id = /\/answer\/(\d+)/.exec(path)?.[1] ?? null; data.article_id = /\/p\/(\d+)/.exec(path)?.[1] ?? null }
  if (platform === 'xiaohongshu') data.note_id = /\/(?:explore|discovery\/item)\/([^/]+)/.exec(path)?.[1] ?? null
  return data
}
export function finishPlatformItems(request, rows, { softDates = false } = {}) {
  const { platform, args, filters } = request
  const items = [], diagnostics = { removed: 0, unknown_dates: 0, unknown_authors: 0, invalid_identity: 0 }
  const seen = new Map(), blocks = new Map(), discussions = new Map(), conflictingDates = new Set(), conflictingAuthors = new Set()
  // X has already run its own normalization, dedupe and strict constraint checks.
  for (const raw of rows ?? []) {
    const url = platform === 'x' ? raw?.url : platformUrl(platform, raw?.url)
    if (!url) { diagnostics.invalid_identity++; continue }
    const category = platformContentType(platform, url, args.type)
    const item = { url, title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '', text: String(raw.text ?? raw.snippet ?? '').slice(0, 8000),
      published: typeof (raw.published ?? raw.created_at) === 'string' ? raw.published ?? raw.created_at : null, author: typeof raw.author === 'string' ? raw.author : null,
      content_type: category, engineRanks: { ...(raw.engineRanks ?? {}) }, provenance: publicProvenance(raw.provenance, platform),
      ...(raw.engines ? { engines: [...raw.engines] } : {}), ...(raw.coverage ? { coverage: raw.coverage } : {}),
    }
    if (platform === 'x') for (const key of ['id', 'username', 'created_at', 'name', 'recent_posts', 'bio', 'followers', 'following', 'verified', 'likes', 'reposts', 'replies', 'views', 'lang', 'media', 'in_reply_to']) if (raw[key] !== undefined) item[key] = structuredClone(raw[key])
    if (platform === 'reddit') for (const key of ['id', 'subreddit', 'created_utc', 'retrieved_on']) if (raw[key] !== undefined) item[key] = raw[key]
    if (platform === 'reddit') {
      item.id = /\/comments\/([a-z0-9]+)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''
      item.subreddit = /\/r\/([a-z0-9_]+)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? ''
    }
    const key = platformIdentityKey(platform, url, category), prior = seen.get(key)
    if (platform === 'bilibili') {
      const block = projectVideoBlock(raw.video_block ?? raw.data?.video_block, url)
      if (block) blocks.set(key, block)
    }
    if (platform === 'xiaohongshu' || platform === 'zhihu') {
      const discussion = projectDiscussion(platform, raw.discussion ?? raw.data?.discussion, url)
      if (discussion) discussions.set(key, discussion)
    }
    if (platform !== 'x' && raw.dateStatus === 'conflicting') conflictingDates.add(key)
    if (prior) {
      if (platform !== 'x' && prior.author && item.author && prior.author.toLowerCase() !== item.author.toLowerCase()) conflictingAuthors.add(key)
      if (!prior.author && item.author) prior.author = item.author
      const a = publicationWindow(prior.published), b = publicationWindow(item.published)
      if (platform !== 'x' && a && b && (a.to < b.from || b.to < a.from)) conflictingDates.add(key)
      if (!prior.published || a && b && b.to - b.from < a.to - a.from) prior.published = item.published
      if (item.text.length > prior.text.length) prior.text = item.text
      for (const [engine, rank] of Object.entries(item.engineRanks)) prior.engineRanks[engine] = Math.min(prior.engineRanks[engine] ?? Infinity, rank)
      prior.provenance.push(...item.provenance)
    } else seen.set(key, item)
  }
  for (const [key, item] of seen) {
    if (conflictingDates.has(key)) item.published = null
    if (conflictingAuthors.has(key)) item.author = null
    if (filters.contentType && item.content_type !== filters.contentType) { diagnostics.removed++; continue }
    const from = softDates === true || softDates?.from === true ? null : filters.from
    const to = softDates === true || softDates?.to === true ? null : filters.to
    if (platform !== 'x' && (from !== null || to !== null)) {
      const date = publicationWindow(item.published)
      if (!date) { diagnostics.unknown_dates++; continue }
      if (from !== null && date.to < from || to !== null && date.from > to) { diagnostics.removed++; continue }
      if (from !== null && date.from < from || to !== null && date.to > to) { diagnostics.unknown_dates++; continue }
    }
    if (platform === 'reddit' && args.subreddits?.length && !args.subreddits.some(scope => scope.toLowerCase() === item.subreddit)) { diagnostics.removed++; continue }
    if (platform === 'reddit' && (filters.allowedAuthors?.length || filters.excludedAuthors?.length)) {
      const author = item.author?.toLowerCase()
      if (!author || !/^[a-z0-9_-]{1,64}$/.test(author)) { diagnostics.unknown_authors++; continue }
      if (filters.allowedAuthors?.length && !filters.allowedAuthors.includes(author) || filters.excludedAuthors?.includes(author)) { diagnostics.removed++; continue }
    }
    item.data = platformData(platform, item, item.content_type)
    if (blocks.has(key)) item.data.video_block = blocks.get(key)
    if (discussions.has(key)) item.data.discussion = discussions.get(key)
    items.push(item)
  }
  const warnings = []
  if (conflictingDates.size) warnings.push(`${conflictingDates.size} rows have conflicting publication observations; date remains unknown`)
  if (conflictingAuthors.size) warnings.push(`${conflictingAuthors.size} rows have conflicting author observations; identity remains unknown`)
  if (diagnostics.unknown_dates) warnings.push(`${diagnostics.unknown_dates} rows excluded: publication date unverified`)
  if (diagnostics.unknown_authors) warnings.push(`${diagnostics.unknown_authors} rows excluded: author identity unverified`)
  if (diagnostics.removed) warnings.push(`${diagnostics.removed} rows excluded by platform conditions`)
  return { items, diagnostics, warnings }
}
