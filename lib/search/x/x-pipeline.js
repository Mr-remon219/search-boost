import { normalizeHandle, xIdentity, isoDate, dedupeBy, filterVerified, resultLimit } from '../results.js'
export { normalizeHandle, xIdentity } from '../results.js'

// Shared X result contract. Providers only retrieve/decode; every runtime path
// finishes here: normalize → merge/dedupe → filter → limit.

const DAY = 86_400_000
const X_EPOCH = 1288834974657n
const METRICS = ['likes', 'reposts', 'replies', 'views']
const asArray = (v) => Array.isArray(v) ? v : v ? [v] : []
const nonempty = (v) => v !== undefined && v !== null && v !== ''

/** Modern Snowflake IDs carry the posting time; old sequential IDs do not. */
export function snowflakeDate(id) {
  if (!/^\d{15,19}$/.test(String(id))) return undefined
  const n = BigInt(id)
  if (n > 9223372036854775807n) return undefined
  const ms = Number((n >> 22n) + X_EPOCH)
  if (ms > Date.now() + DAY) return undefined
  return new Date(ms).toISOString()
}

function metric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (String(value).trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function normalizePosts(raw) {
  return asArray(raw).flatMap((p) => {
    if (!p || typeof p !== 'object') return []
    const identity = xIdentity(p.url)
    if (p.url && !identity.id) return [] // supplied non-post URLs cannot lend identity to a fabricated id
    // A URL is stronger evidence than a model-provided id/handle.
    const rawId = typeof p.id === 'number' && !Number.isSafeInteger(p.id) ? '' : String(p.id ?? '')
    const id = identity.id || (/^\d+$/.test(rawId) ? rawId : '')
    if (!id) return [] // profile/search links are not posts
    const username = identity.username || normalizeHandle(p.username)
    const out = {
      id,
      ...(nonempty(p.author) ? { author: String(p.author) } : username ? { author: username } : {}),
      ...(username ? { username } : {}),
      text: String(p.text ?? p.snippet ?? ''),
      url: `https://x.com/${username || 'i'}/status/${id}`,
    }
    const createdAt = snowflakeDate(id) || isoDate(p.created_at)
    if (createdAt) out.created_at = createdAt
    for (const key of METRICS) {
      const n = metric(p[key])
      if (n !== undefined) out[key] = n
    }
    if (Array.isArray(p.engines)) out.engines = [...new Set(p.engines.filter((e) => typeof e === 'string'))]
    if (p.lang) out.lang = String(p.lang).toLowerCase()
    if (Array.isArray(p.media) && p.media.length) out.media = p.media.filter((m) => typeof m === 'string')
    if (p.in_reply_to != null) out.in_reply_to = String(p.in_reply_to)
    return [out]
  })
}

export function normalizeUsers(raw) {
  return asArray(raw).flatMap((u) => {
    if (!u || typeof u !== 'object') return []
    const identity = xIdentity(u.url)
    const username = (!identity.id && identity.username) || normalizeHandle(u.username)
    if (!username) return []
    const out = {
      id: String(u.id ?? ''), name: String(u.name ?? username), username,
      bio: String(u.bio ?? ''), url: `https://x.com/${username}`,
      recent_posts: normalizePosts(u.recent_posts),
    }
    for (const key of ['followers', 'following']) {
      const n = metric(u[key])
      if (n !== undefined) out[key] = n
    }
    if (typeof u.verified === 'boolean') out.verified = u.verified
    const createdAt = isoDate(u.created_at)
    if (createdAt) out.created_at = createdAt
    return [out]
  })
}

function boundary(value, name, end = false) {
  if (!value) return undefined
  const text = String(value)
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const ms = Date.parse(text)
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$)/.test(text)
    || new Date(Date.parse(text.slice(0, 10))).toISOString().slice(0, 10) !== text.slice(0, 10)) {
    throw new Error(`x_search: invalid ${name}; use YYYY-MM-DD or an ISO8601 timestamp with timezone`)
  }
  // xAI includes both dates. Query until: is separately exclusive.
  return ms + (end && dayOnly ? DAY - 1 : 0)
}

const all = (checks) => (p) => {
  const values = checks.map((check) => check(p))
  return values.includes(false) ? false : values.includes(null) ? null : true
}
const negate = (check) => (p) => { const value = check(p); return value === null ? null : !value }
const any = (checks) => (p) => {
  const values = checks.map((check) => check(p))
  return values.includes(true) ? true : values.includes(null) ? null : false
}
const fieldCheck = (key, test) => (p) => nonempty(p[key]) ? test(p[key]) : null

/** Small boolean parser for metadata operators, NOT a second relevance engine.
 * Quoted phrases stay opaque. Unrecognized terms remain provider-side; they
 * cannot safely be checked against truncated snippets or semantic matches.
 */
function queryCheck(query, warnings) {
  const tokens = String(query).match(/(?:[^\s()"]+|"[^"]*")+|[()]/g) ?? []
  if (!tokens.length) return () => true
  let index = 0
  let opaqueTerms = 0
  function atom(token) {
    const match = /^(-?)(from|since|until|min_faves|min_retweets|min_replies|lang):(.*)$/i.exec(token)
    if (!match) {
      opaqueTerms++
      if (/^-?[a-z_]+:/i.test(token)) warnings.add(`Query operator ${token.split(':')[0]}: is provider-side only; not locally verified.`)
      return () => true
    }
    const [, negated, op0, rawValue] = match
    const value = rawValue.replace(/^"([^"]*)"$/, '$1')
    if (!value) throw new Error(`x_search: missing ${op0}: value`)
    const op = op0.toLowerCase()
    let check
    if (op === 'from') {
      const handle = normalizeHandle(value)
      if (!handle) throw new Error(`x_search: invalid from: handle ${value}`)
      check = fieldCheck('username', (v) => v === handle)
    } else if (op === 'since' || op === 'until') {
      const ms = boundary(value, `${op}:`)
      check = fieldCheck('created_at', (v) => op === 'since' ? Date.parse(v) >= ms : Date.parse(v) < ms)
    } else if (op === 'lang') {
      check = fieldCheck('lang', (v) => v === value.toLowerCase())
    } else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`x_search: invalid ${op}: threshold`)
      const key = { min_faves: 'likes', min_retweets: 'reposts', min_replies: 'replies' }[op]
      check = fieldCheck(key, (v) => v >= Number(value))
    }
    return negated ? negate(check) : check
  }
  function conjunction() {
    const checks = []
    let needsTerm = true
    while (index < tokens.length && tokens[index] !== ')' && tokens[index] !== 'OR') {
      let token = tokens[index++]
      if (token === 'AND') {
        if (needsTerm) throw new Error('x_search: missing query operand')
        needsTerm = true
        continue
      }
      const negativeGroup = token === '-' && tokens[index] === '('
      if (negativeGroup) token = tokens[index++]
      if (token === '(') {
        const opaqueBefore = opaqueTerms
        const group = disjunction()
        if (negativeGroup && opaqueTerms !== opaqueBefore) {
          warnings.add('Negated groups containing text or unsupported operators remain provider-side; not locally verified.')
          checks.push(() => true)
        } else checks.push(negativeGroup ? negate(group) : group)
        if (tokens[index++] !== ')') throw new Error('x_search: unbalanced query parentheses')
      } else checks.push(atom(token))
      needsTerm = false
    }
    if (needsTerm) throw new Error('x_search: missing query operand')
    return all(checks)
  }
  function disjunction() {
    const checks = [conjunction()]
    while (tokens[index] === 'OR') { index++; checks.push(conjunction()) }
    return any(checks)
  }
  // Ordinary text/code such as async() need not obey metadata grammar.
  if (!tokens.some((t) => /^-?(from|since|until|min_faves|min_retweets|min_replies|lang):/i.test(t))) {
    tokens.forEach(atom)
    return () => true
  }
  const check = disjunction()
  if (index !== tokens.length) throw new Error('x_search: unbalanced query parentheses')
  if (tokens.includes('OR')) warnings.add('OR is evaluated locally for metadata operators; text/relevance branches remain provider-side.')
  return check
}

/** Merge before filtering so another source can fill missing author/date/counts. */
function dedupe(rows, userMode) {
  return dedupeBy(rows, (row) => userMode ? row.item.username : row.item.id, (prior, row) => {
    for (const [k, v] of Object.entries(row.item)) {
      if (userMode && k === 'recent_posts') continue
      if (k === 'text' && typeof v === 'string' && v.length > String(prior.item[k] ?? '').length) prior.item[k] = v
      if (!nonempty(prior.item[k]) || (Array.isArray(prior.item[k]) && !prior.item[k].length)) prior.item[k] = v
    }
    if (prior.item.engines || row.item.engines) prior.item.engines = [...new Set([...(prior.item.engines ?? []), ...(row.item.engines ?? [])])]
    if (userMode) prior.item.recent_posts = [...prior.item.recent_posts, ...row.item.recent_posts]
    else if (prior.item.username) prior.item.url = `https://x.com/${prior.item.username}/status/${prior.item.id}`
    return prior
  })
}

export function createXPipeline(args, limit = 5) {
  limit = resultLimit(limit, 30, 5)
  const warnings = new Set()
  const params = { ...args }
  for (const key of ['allowed_x_handles', 'excluded_x_handles']) {
    const values = asArray(args[key])
    const handles = values.map(normalizeHandle)
    if (handles.some((h) => !h)) throw new Error(`x_search: invalid ${key}`)
    params[key] = [...new Set(handles)]
    if (params[key].length > 20) throw new Error(`x_search: ${key} supports at most 20 handles`)
  }
  if (params.allowed_x_handles.length && params.excluded_x_handles.length) throw new Error('x_search: allowed_x_handles and excluded_x_handles are mutually exclusive — pass only one')
  if (nonempty(args.username)) {
    params.username = normalizeHandle(args.username)
    if (!params.username) throw new Error('x_search: invalid username')
  }
  if (params.type === 'keyword' && !String(params.query ?? '').trim() && params.username) params.query = `from:${params.username}`
  const start = boundary(args.from_date, 'from_date')
  const end = boundary(args.to_date, 'to_date', true)
  if (start !== undefined && end !== undefined && start > end) throw new Error('x_search: from_date must not be after to_date')
  const authorChecks = []
  if (params.allowed_x_handles.length) authorChecks.push(fieldCheck('username', (v) => params.allowed_x_handles.includes(v)))
  if (params.excluded_x_handles.length) authorChecks.push(fieldCheck('username', (v) => !params.excluded_x_handles.includes(v)))
  if (params.username && ['keyword', 'semantic', 'user'].includes(params.type)) authorChecks.push(fieldCheck('username', (v) => v === params.username))
  const authorCheck = all(authorChecks)
  const checks = [authorCheck]
  if (start !== undefined) checks.push(fieldCheck('created_at', (v) => Date.parse(v) >= start))
  if (end !== undefined) checks.push(fieldCheck('created_at', (v) => Date.parse(v) <= end))
  if (params.type === 'keyword') checks.push(queryCheck(params.query, warnings))
  const postCheck = all(checks)

  // Recall hints, not enforcement: engines need not understand X operators.
  const hints = [params.query ?? '']
  if (params.username) hints.push(`from:${params.username}`)
  if (params.allowed_x_handles.length) hints.push(`(${params.allowed_x_handles.map((h) => `from:${h}`).join(' OR ')})`)
  hints.push(...params.excluded_x_handles.map((h) => `-from:${h}`))
  if (start !== undefined) hints.push(`since:${new Date(start).toISOString().slice(0, 10)}`)
  if (end !== undefined) hints.push(`until:${new Date(Math.floor(end / DAY) * DAY + DAY).toISOString().slice(0, 10)}`)
  const searchQuery = hints.filter(Boolean).join(' ')
  const candidateLimit = Math.min(30, Math.max(limit * 3, 10))

  return {
    params, searchQuery, candidateLimit,
    finish(batches, { applyConstraints = true, limitResults = true } = {}) {
      let unknown = 0
      let rejected = 0
      const verify = (rows, check) => {
        const out = filterVerified(rows, check)
        unknown += out.unknown; rejected += out.rejected
        return out.items
      }
      const userMode = params.type === 'user'
      const rows = dedupe(batches.flatMap(({ source, data }) => (userMode ? normalizeUsers(data) : normalizePosts(data)).map((item) => ({ source, item: source === 'official' ? { ...item, engines: ['x-official'] } : item }))), userMode)
      const filtered = applyConstraints ? verify(rows, ({ item }) => (userMode ? authorCheck : postCheck)(item)) : rows
      if (userMode && applyConstraints) for (const { item } of filtered) {
        item.recent_posts = verify(dedupe(item.recent_posts.map((post) => ({ item: post })), false)
          .map(({ item: post }) => post), postCheck).slice(0, limit)
      }
      const kept = limitResults ? filtered.slice(0, limit) : filtered
      const notes = [...warnings]
      if (unknown) notes.push(`${unknown} candidate(s) omitted: missing metadata required to verify filters.`)
      if (rejected) notes.push(`${rejected} candidate(s) removed by local filters.`)
      return {
        items: kept.map(({ item }) => item), results: kept.length,
        xResults: kept.filter(({ source }) => source === 'official').length,
        engineResults: kept.filter(({ source }) => source === 'engines').length,
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }
    },
  }
}
