import { plainText, unixTime } from './native-reader.mjs'
import { platformUrl } from './selection.mjs'

export const DISCUSSION_SCOPE = 'accessible_to_current_session'
export const DISCUSSION_REASONS = ['pagination_not_exhausted', 'count_unknown', 'count_mismatch', 'cursor_cycle', 'response_invalid', 'identity_mismatch', 'content_unavailable', 'capacity', 'page_limit', 'deadline', 'access_denied', 'stalled', 'driver_unavailable']
const idOf = value => /^(?:[a-z0-9_-]{1,100})$/i.test(String(value ?? '')) ? String(value) : null
const countOf = value => {
  const text = String(value ?? '')
  const exact = /^(?:0|[1-9]\d*)$/.test(text) ? text : /^[1-9]\d{0,2}(?:,\d{3})+$/.test(text) ? text.replaceAll(',', '') : null
  return exact !== null && Number.isSafeInteger(Number(exact)) ? Number(exact) : null
}
export function discussionByteLimit(maxResults = 5) { return Math.min(512_000, Math.floor(3_000_000 / Math.max(1, maxResults))) }
export function discussionTarget(platform, value) {
  const url = platformUrl(platform, value)
  if (!url) return null
  const path = new URL(url).pathname
  const note = /\/(?:explore|discovery\/item)\/([a-f0-9]{24})$/i.exec(path)
  const question = /\/question\/(\d+)/.exec(path), article = /\/p\/(\d+)/.exec(path), answer = /\/answer\/(\d+)/.exec(path)
  if (platform === 'xiaohongshu' && note) return { kind: 'note', id: note[1], url, selected_id: note[1] }
  if (platform === 'zhihu' && question) return { kind: 'question', id: question[1], url: 'https://www.zhihu.com/question/' + question[1], selected_id: answer?.[1] ?? question[1] }
  if (platform === 'zhihu' && article) return { kind: 'article', id: article[1], url, selected_id: article[1] }
  return null
}
const entityKey = (kind, id) => kind + ':' + id
const rootKey = (kind, id) => 'comments:' + entityKey(kind, id)
const replyKey = (kind, id, root) => 'replies:' + entityKey(kind, id) + ':' + root
function fullBody(value) { return typeof value === 'string' ? plainText(value, Infinity) : null }
function publicEntity(platform, kind, row, questionId) {
  const id = idOf(row?.id)
  if (!id || !['question', 'answer', 'article'].includes(kind)) return null
  if (kind === 'answer' && String(row.question?.id) !== questionId) return null
  const text = fullBody(kind === 'question' ? row.detail : row.content)
  return { id, kind, url: kind === 'question' ? 'https://www.zhihu.com/question/' + id : kind === 'answer' ? 'https://www.zhihu.com/question/' + questionId + '/answer/' + id : 'https://zhuanlan.zhihu.com/p/' + id,
    title: plainText(row.title ?? row.question?.title, 500), text: text ?? '', author: plainText(row.author?.name, 200) || null,
    published: unixTime(row.created_time ?? row.created), body_complete: text !== null && (kind === 'question' || row.content.length > 0) && row.content_is_truncated !== true && row.is_locked !== true,
    expected_comments: countOf(row.comment_count ?? row.commentCount) }
}

/** Session-local evidence accumulator. No raw responses, signatures or cursors are public. */
export function createDiscussion(platform, value, { maxBytes = 512_000, maxPages = 200 } = {}) {
  const target = discussionTarget(platform, value)
  if (!target) throw new Error('Invalid discussion target')
  const entities = new Map(), comments = new Map(), sections = new Map(), pages = new Map(), frontiers = new Map()
  let failure = null, bytes = 0, pageCount = 0
  const fail = reason => { failure ??= DISCUSSION_REASONS.includes(reason) ? reason : 'response_invalid' }
  const retain = (map, key, row) => {
    const previous = map.get(key)
    const size = Buffer.byteLength(JSON.stringify(row)) - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0) + (previous ? 0 : 512)
    if (bytes + size > maxBytes) { fail('capacity'); return false }
    bytes += size; map.set(key, row); return true
  }
  const section = (key, kind, entityKind, entityId, rootId = null) => {
    if (!sections.has(key)) sections.set(key, { kind, entity_kind: entityKind, entity_id: entityId, root_id: rootId, complete: false, expected_count: null, stop_reason: null })
    return sections.get(key)
  }
  const ensureEntity = (kind, id, expected = null) => {
    const part = section(rootKey(kind, id), 'comments', kind, id)
    if (expected !== null) {
      const previous = part.expected_count
      part.expected_count = Math.max(previous ?? 0, expected)
      if (previous !== null && part.expected_count > previous) part.complete = false
    }
    // An explicit zero count is a terminal empty collection, not missing metadata.
    if (part.expected_count === 0) part.complete = true
    return part
  }
  if (target.kind !== 'question') ensureEntity(target.kind, target.id)
  const addEntity = (kind, raw, verifiedBody = false) => {
    const row = publicEntity(platform, kind, raw, target.id)
    if (!row || kind === 'question' && row.id !== target.id || kind === 'article' && row.id !== target.id) { fail('identity_mismatch'); return }
    if (kind === 'answer' && !verifiedBody) row.body_complete = false
    const previous = entities.get(entityKey(kind, row.id))
    if (previous) {
      if (previous.body_complete && (!row.body_complete || row.text.length < previous.text.length)) { row.text = previous.text; row.body_complete = true }
      row.author ??= previous.author
      if (previous.expected_comments !== null) row.expected_comments = Math.max(previous.expected_comments, row.expected_comments ?? 0)
      row.published ??= previous.published
      if (!row.title) row.title = previous.title
    }
    if (!retain(entities, entityKey(kind, row.id), row)) return
    ensureEntity(kind, row.id, row.expected_comments)
  }
  const addComment = (kind, entityId, raw, rootId = null) => {
    const id = idOf(raw?.id), text = fullBody(raw?.content)
    if (!id || text === null || platform === 'xiaohongshu' && (raw.note_id ?? raw.noteId) !== undefined && String(raw.note_id ?? raw.noteId) !== target.id) { fail('identity_mismatch'); return null }
    const entity = entities.get(entityKey(kind, entityId))
    const url = platform === 'xiaohongshu' ? target.url : kind === 'answer' ? 'https://www.zhihu.com/question/' + target.id + '/answer/' + entityId : entity?.url ?? target.url
    const replyTo = platform === 'xiaohongshu' ? raw.target_comment?.id ?? raw.targetComment?.id : raw.reply_comment_id
    const parent = rootId ? idOf(replyTo) ?? rootId : null
    const row = { id, entity_kind: kind, entity_id: entityId, root_id: rootId ?? id, parent_id: parent === '0' ? rootId : parent,
      url, text, author: plainText(platform === 'xiaohongshu' ? raw.user_info?.nickname ?? raw.userInfo?.nickname : raw.author?.name, 200) || null,
      published: unixTime(platform === 'xiaohongshu' ? raw.create_time ?? raw.createTime : raw.created_time, platform === 'xiaohongshu'), body_complete: raw.content_is_truncated !== true }
    const key = entityKey(kind, entityId) + ':' + id, previous = comments.get(key)
    if (previous && (previous.root_id !== row.root_id || previous.parent_id !== row.parent_id)) { fail('identity_mismatch'); return null }
    if (!row.body_complete) fail('content_unavailable')
    if (!retain(comments, key, row)) return null
    if (!rootId) {
      const child = section(replyKey(kind, entityId, id), 'replies', kind, entityId, id)
      child.expected_count = countOf(platform === 'xiaohongshu' ? raw.sub_comment_count ?? raw.subCommentCount : raw.child_comment_count)
      const inline = platform === 'xiaohongshu' ? raw.sub_comments ?? raw.subComments : raw.child_comments
      if (inline !== undefined && !Array.isArray(inline)) fail('response_invalid')
      for (const reply of Array.isArray(inline) ? inline : []) addComment(kind, entityId, reply, id)
      const collected = [...comments.values()].filter(c => c.entity_kind === kind && c.entity_id === entityId && c.root_id === id && c.parent_id !== null).length
      child.complete = child.expected_count !== null && child.expected_count === collected
      const more = raw.sub_comment_has_more ?? raw.subCommentHasMore
      if (platform === 'xiaohongshu' && more === true) child.complete = false
      if (platform === 'xiaohongshu' && more === false) child.complete = child.expected_count === null || child.expected_count === collected
      const cursor = raw.sub_comment_cursor ?? raw.subCommentCursor
      if (platform === 'xiaohongshu' && more === true && typeof cursor === 'string' && cursor) frontiers.set(replyKey(kind, entityId, id), { next: cursor, closed: false })
    }
    return id
  }
  const acceptPage = (key, cursor, rows, end, next) => {
    if (!Array.isArray(rows) || typeof end !== 'boolean') { fail('response_invalid'); return false }
    const signature = JSON.stringify(rows.map(row => String(row?.id ?? row?.target?.id ?? '')))
    const pageKey = key + ':' + String(cursor ?? '')
    if (pages.has(pageKey)) {
      if (pages.get(pageKey) !== signature) fail('cursor_cycle')
      return false
    }
    if (++pageCount > maxPages) { fail('page_limit'); return false }
    const current = String(cursor ?? ''), previous = frontiers.get(key)
    const initialAnswers = key === 'answers:question:' + target.id && Number.isSafeInteger(sections.get(key)?.expected_count) && [...entities.values()].some(row => row.kind === 'answer')
    if (previous ? previous.closed || previous.next !== current : !['', '0'].includes(current) && !initialAnswers) fail('pagination_not_exhausted')
    if (!end && (!next || String(next) === current || pages.has(key + ':' + String(next)))) fail('cursor_cycle')
    if (!end && rows.length === 0) fail('response_invalid')
    pages.set(pageKey, signature)
    frontiers.set(key, { next: next == null ? null : String(next), closed: end })
    return true
  }
  const receive = (url, document) => {
    if (failure) return
    let parsed
    try { parsed = new URL(url) } catch { fail('response_invalid'); return }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) { fail('identity_mismatch'); return }
    if (document?.success === false || document?.error || document?.code !== undefined && document.code !== 0) { fail('access_denied'); return }
    if (platform === 'xiaohongshu') {
      if (parsed.hostname !== 'edith.xiaohongshu.com' || parsed.searchParams.get('note_id') !== target.id) return
      const child = parsed.pathname === '/api/sns/web/v2/comment/sub/page'
      if (!child && parsed.pathname !== '/api/sns/web/v2/comment/page') return
      const doc = document?.data ?? document, root = child ? idOf(parsed.searchParams.get('root_comment_id')) : null
      if (child && !comments.has('note:' + target.id + ':' + root)) { fail('identity_mismatch'); return }
      const key = child ? replyKey('note', target.id, root) : rootKey('note', target.id)
      if (!acceptPage(key, parsed.searchParams.get('cursor'), doc?.comments, doc?.has_more === false ? true : doc?.has_more === true ? false : null, doc?.cursor)) return
      for (const row of doc.comments) addComment('note', target.id, row, root)
      section(key, child ? 'replies' : 'comments', 'note', target.id, root).complete = doc.has_more === false
      return
    }
    if (parsed.hostname !== 'www.zhihu.com') return
    const answerPage = new RegExp('^/api/v4/questions/' + target.id + '/(?:answers|feeds)$').test(parsed.pathname)
    const metadata = parsed.pathname === '/api/v4/questions/' + target.id
    if (metadata) { addEntity('question', document); return }
    const rootMatch = /^\/api\/v4\/comment_v5\/(questions|answers|articles)\/(\d+)\/root_comment$/.exec(parsed.pathname)
    const childMatch = /^\/api\/v4\/comment_v5\/comment\/(\d+)\/child_comment$/.exec(parsed.pathname)
    if (!answerPage && !rootMatch && !childMatch) return
    const doc = document, paging = doc?.paging
    let next = null
    if (paging?.is_end === false) {
      try {
        const n = new URL(paging.next)
        if (n.origin !== parsed.origin || n.pathname !== parsed.pathname || n.username || n.password) throw new Error('Foreign continuation')
        // Server-owned page sizes may change. Cursor identity, not fixed limit, proves progress.
        next = n.searchParams.get('cursor') ?? n.searchParams.get('offset')
      } catch { fail('identity_mismatch'); return }
    }
    if (answerPage) {
      const key = 'answers:question:' + target.id
      if (!acceptPage(key, parsed.searchParams.get('cursor') ?? parsed.searchParams.get('offset'), doc.data, paging?.is_end, next)) return
      for (const row of doc.data) addEntity('answer', row.target ?? row)
      section(key, 'answers', 'question', target.id).complete = paging.is_end
      return
    }
    let kind, entityId, root = null
    if (rootMatch) {
      kind = { questions: 'question', answers: 'answer', articles: 'article' }[rootMatch[1]]; entityId = rootMatch[2]
      if (!sections.has(rootKey(kind, entityId))) return
    } else {
      root = childMatch[1]
      const parent = [...comments.values()].find(row => row.id === root && row.parent_id === null)
      if (!parent) return
      kind = parent.entity_kind; entityId = parent.entity_id
    }
    const key = root ? replyKey(kind, entityId, root) : rootKey(kind, entityId)
    if (!acceptPage(key, parsed.searchParams.get('offset'), doc.data, paging?.is_end, next)) return
    for (const row of doc.data) addComment(kind, entityId, row, root)
    section(key, root ? 'replies' : 'comments', kind, entityId, root).complete = paging.is_end
  }
  const seed = (state, { detailUrl } = {}) => {
    const detail = detailUrl ? platformUrl(platform, detailUrl) : null
    const detailAnswer = detail && /\/question\/(\d+)\/answer\/(\d+)$/.exec(new URL(detail).pathname)
    if (platform === 'xiaohongshu') {
      const row = state?.note?.noteDetailMap?.[target.id]
      const count = countOf(row?.note?.interactInfo?.commentCount)
      ensureEntity('note', target.id, count)
      const page = row?.comments
      if (page && Array.isArray(page.list ?? page.comments) && typeof (page.hasMore ?? page.has_more) === 'boolean') receive('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?' + new URLSearchParams({ note_id: target.id, cursor: '' }), { comments: page.list ?? page.comments, has_more: page.hasMore ?? page.has_more, cursor: page.cursor })
      return
    }
    const source = state?.initialState?.entities ?? state?.entities
    if (!source) return
    if (target.kind === 'article') { if (source.articles?.[target.id]) addEntity('article', { ...source.articles[target.id], author: typeof source.articles[target.id].author === 'string' ? source.users?.[source.articles[target.id].author] : source.articles[target.id].author }); return }
    if (source.questions?.[target.id]) {
      const question = source.questions[target.id]
      addEntity('question', { ...question, author: typeof question.author === 'string' ? source.users?.[question.author] : question.author })
      const stream = section('answers:question:' + target.id, 'answers', 'question', target.id)
      const expectedAnswers = countOf(question.answer_count ?? question.answerCount)
      if (expectedAnswers !== null) {
        const previous = stream.expected_count
        stream.expected_count = Math.max(previous ?? 0, expectedAnswers)
        if (previous !== null && stream.expected_count > previous) stream.complete = false
      }
      if (stream.expected_count === 0) stream.complete = true
    }
    for (const row of Object.values(source.answers ?? {})) if (String(row?.question?.id) === target.id) addEntity('answer', { ...row, author: typeof row.author === 'string' ? source.users?.[row.author] : row.author }, detailAnswer?.[1] === target.id && detailAnswer?.[2] === String(row.id))
  }
  const snapshot = () => {
    const list = [...comments.values()], bodies = [...entities.values()]
    const publicSections = [...sections.values()].map(part => {
      const collected = part.kind === 'answers' ? bodies.filter(row => row.kind === 'answer').length : part.kind === 'replies' ? list.filter(row => row.entity_kind === part.entity_kind && row.entity_id === part.entity_id && row.root_id === part.root_id && row.parent_id !== null).length : list.filter(row => row.entity_kind === part.entity_kind && row.entity_id === part.entity_id).length
      return { ...part, complete: part.complete && !part.stop_reason && part.expected_count !== null && part.expected_count === collected, collected_count: collected }
    })
    let reason = failure ?? publicSections.find(part => part.stop_reason)?.stop_reason
    if (!reason && publicSections.some(part => part.expected_count !== null && part.complete === false && part.collected_count !== part.expected_count && sections.get(part.kind === 'answers' ? 'answers:question:' + target.id : part.root_id ? replyKey(part.entity_kind, part.entity_id, part.root_id) : rootKey(part.entity_kind, part.entity_id))?.complete)) reason = 'count_mismatch'
    if (!reason && publicSections.some(part => part.expected_count === null)) reason = 'count_unknown'
    if (!reason && bodies.some(row => !row.body_complete)) reason = 'content_unavailable'
    if (!reason && (target.kind === 'question' && (!entities.has('question:' + target.id) || !sections.has('answers:question:' + target.id)) || publicSections.some(part => !part.complete))) reason = 'pagination_not_exhausted'
    if (!reason && list.some(row => row.parent_id !== null && !comments.has(entityKey(row.entity_kind, row.entity_id) + ':' + row.parent_id))) reason = 'identity_mismatch'
    return { schema_version: 1, target_kind: target.kind, target_id: target.id, target_url: target.url, scope: DISCUSSION_SCOPE,
      status: reason ? 'partial' : 'complete', stop_reason: reason ?? null, pages: pageCount, sections: publicSections, entities: bodies, comments: list }
  }
  return { target, seed, receive, fail, snapshot,
    failEntity(kind, id, reason, answers = false) {
      const part = section(answers ? 'answers:question:' + id : rootKey(kind, id), answers ? 'answers' : 'comments', kind, id)
      part.stop_reason ??= DISCUSSION_REASONS.includes(reason) ? reason : 'response_invalid'
    },
    needsRead(kind, id, answers = false) {
      return [...sections.values()].some(part => (answers ? part.kind === 'answers' : part.kind !== 'answers') && part.entity_kind === kind && part.entity_id === id && !part.complete && !part.stop_reason)
    },
    confirmAnswersEnd() {
      const stream = sections.get('answers:question:' + target.id)
      const count = [...entities.values()].filter(row => row.kind === 'answer').length
      if (stream?.expected_count !== null && stream?.expected_count === count) stream.complete = true
    }, get stopped() { return failure !== null } }
}

/** Re-project only closed documented fields; keep completeness evidence, not transport data. */
export function projectDiscussion(platform, value, url) {
  const target = discussionTarget(platform, url)
  if (!target || value?.schema_version !== 1 || value.target_id !== target.id || value.target_kind !== target.kind || value.target_url !== target.url || value.scope !== DISCUSSION_SCOPE || !Array.isArray(value.entities) || !Array.isArray(value.comments) || !Array.isArray(value.sections)) return undefined
  const output = { schema_version: 1, target_kind: target.kind, target_id: target.id, target_url: target.url, scope: DISCUSSION_SCOPE,
    status: value.status === 'complete' ? 'complete' : 'partial', stop_reason: value.stop_reason === null ? null : DISCUSSION_REASONS.includes(value.stop_reason) ? value.stop_reason : 'response_invalid', pages: countOf(value.pages) ?? 0,
    sections: [], entities: [], comments: [] }
  for (const row of value.entities) {
    const kind = row?.kind, id = idOf(row?.id)
    if (!id || !['question', 'answer', 'article'].includes(kind) || kind !== 'answer' && id !== target.id || target.kind !== 'question' && kind !== target.kind) { output.status = 'partial'; output.stop_reason = 'identity_mismatch'; continue }
    output.entities.push({ id, kind, url: kind === 'answer' ? 'https://www.zhihu.com/question/' + target.id + '/answer/' + id : target.url,
      title: plainText(row.title, 500), text: plainText(row.text, Infinity), author: typeof row.author === 'string' ? plainText(row.author, 200) : null, published: typeof row.published === 'string' ? row.published : null, body_complete: row.body_complete === true, expected_comments: countOf(row.expected_comments) })
  }
  const known = new Set(output.entities.map(row => entityKey(row.kind, row.id)))
  if (target.kind === 'note') known.add('note:' + target.id)
  for (const row of value.comments) {
    const id = idOf(row?.id), root = idOf(row?.root_id), parent = row.parent_id === null ? null : idOf(row.parent_id)
    if (!id || !root || !known.has(entityKey(row.entity_kind, row.entity_id)) || row.parent_id !== null && !parent) { output.status = 'partial'; output.stop_reason = 'identity_mismatch'; continue }
    const entity = output.entities.find(entity => entity.kind === row.entity_kind && entity.id === row.entity_id)
    output.comments.push({ id, entity_kind: row.entity_kind, entity_id: row.entity_id, root_id: root, parent_id: parent, url: entity?.url ?? target.url, text: plainText(row.text, Infinity),
      author: typeof row.author === 'string' ? plainText(row.author, 200) : null, published: typeof row.published === 'string' ? row.published : null, body_complete: row.body_complete === true })
  }
  for (const part of value.sections) {
    if (!['answers', 'comments', 'replies'].includes(part?.kind) || !known.has(entityKey(part.entity_kind, part.entity_id))) { output.status = 'partial'; output.stop_reason = 'identity_mismatch'; continue }
    output.sections.push({ kind: part.kind, entity_kind: part.entity_kind, entity_id: part.entity_id, root_id: idOf(part.root_id), complete: part.complete === true, stop_reason: DISCUSSION_REASONS.includes(part.stop_reason) ? part.stop_reason : null, expected_count: countOf(part.expected_count), collected_count: countOf(part.collected_count) ?? 0 })
  }
  for (const part of output.sections) {
    const observed = part.kind === 'answers' ? output.entities.filter(row => row.kind === 'answer').length : part.kind === 'replies'
      ? output.comments.filter(row => row.entity_kind === part.entity_kind && row.entity_id === part.entity_id && row.root_id === part.root_id && row.parent_id !== null).length
      : output.comments.filter(row => row.entity_kind === part.entity_kind && row.entity_id === part.entity_id).length
    if (part.stop_reason || part.expected_count === null || part.collected_count !== observed || part.expected_count !== observed) { part.complete = false; output.stop_reason ??= part.stop_reason ?? (part.expected_count === null ? 'count_unknown' : 'count_mismatch') }
    part.collected_count = observed
  }
  const missingRoot = [...known].some(key => !output.sections.some(part => part.kind === 'comments' && entityKey(part.entity_kind, part.entity_id) === key))
  const missingReply = output.comments.some(row => row.parent_id === null && !output.sections.some(part => part.kind === 'replies' && part.entity_kind === row.entity_kind && part.entity_id === row.entity_id && part.root_id === row.id))
  const missingParent = output.comments.some(row => row.parent_id !== null && !output.comments.some(parent => parent.entity_kind === row.entity_kind && parent.entity_id === row.entity_id && parent.id === row.parent_id))
  const missingQuestion = target.kind === 'question' && (!known.has('question:' + target.id) || !output.sections.some(part => part.kind === 'answers' && part.entity_id === target.id))
  if (missingRoot || missingReply || missingParent || missingQuestion || !output.sections.length || output.stop_reason || output.sections.some(part => !part.complete) || output.entities.some(row => !row.body_complete) || output.comments.some(row => !row.body_complete)) { output.status = 'partial'; output.stop_reason ??= 'pagination_not_exhausted' }
  return output
}
