import { plainText, unixTime } from './native-reader.mjs'
import { communityDate } from './dates.mjs'

export function bilibiliLocalTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value)) return null
  try { return new Date(communityDate(value.replace(' ', 'T') + '+08:00')).toISOString() } catch { return null }
}
export function publicNoteText(content) {
  let operations
  try { operations = typeof content === 'string' ? JSON.parse(content) : content } catch { return '' }
  if (!Array.isArray(operations)) return ''
  // Quill embeds are images/timestamps, not written body or a transcript.
  return plainText(operations.slice(0, 2000).map(op => typeof op?.insert === 'string' ? op.insert : '').join(''), 4000)
}
export function publicVideoNote(row, detail, aid) {
  const cvid = String(row?.cvid ?? '')
  if (!/^\d+$/.test(cvid) || String(detail?.cvid) !== cvid || detail.pub_status !== 2 || String(detail.arc?.oid) !== String(aid)) return null
  const text = publicNoteText(detail.content)
  if (!text) return null
  return { cvid, title: plainText(detail.title ?? row.title, 500), text, url: 'https://www.bilibili.com/read/cv' + cvid,
    author: plainText(detail.author?.name ?? row.author?.name, 200) || null, published: bilibiliLocalTime(row.pubtime),
    published_precision: typeof row.pubtime === 'string' ? row.pubtime.length === 16 ? 'minute' : row.pubtime.length === 19 ? 'second' : null : null }
}
export function videoComment(row, bvid) {
  const id = String(row?.rpid_str ?? row?.rpid ?? '')
  const text = plainText(row?.content?.message, 1000)
  if (!/^\d+$/.test(id) || !text) return null
  return { id, text, author: plainText(row.member?.uname, 200) || null, published: unixTime(row.ctime),
    likes: Number.isSafeInteger(row.like) && row.like >= 0 ? row.like : 0, url: 'https://www.bilibili.com/video/' + bvid + '#reply' + id }
}
const api = (path, params) => 'https://api.bilibili.com' + path + '?' + new URLSearchParams(params)
export async function collectVideoBlock(bvid, get, { noteLimit = 3, commentLimit = 5, filters = {}, signal } = {}) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('Invalid Bilibili BV id')
  signal?.throwIfAborted()
  const video = await get(api('/x/web-interface/view', { bvid }))
  if (video.bvid !== bvid || !Number.isSafeInteger(video.aid) || video.aid <= 0) throw new Error('Bilibili video identity changed')
  const block = { schema_version: 1, title: plainText(video.title, 500), url: 'https://www.bilibili.com/video/' + bvid, bvid,
    published: unixTime(video.pubdate), notes: [], comments: [], notes_status: 'not_requested', comments_status: commentLimit ? 'not_requested' : 'disabled',
    coverage: 'bounded public notes and hot root-comment samples; not full notes/comments; no video transcript' }
  let stopped = false
  const inWindow = (published, width = 0) => {
    if (filters.from == null && filters.to == null) return true
    if (!published) return false
    const ms = Date.parse(published)
    return (filters.from == null || ms >= filters.from) && (filters.to == null || ms + width <= filters.to)
  }
  try {
    signal?.throwIfAborted()
    const page = await get(api('/x/note/publish/list/archive', { oid: String(video.aid), oid_type: '0', ps: '10', pn: '1' }))
    if (!Array.isArray(page.list)) throw new Error('Public-note list shape changed')
    block.notes_status = page.list.length ? 'sampled' : 'empty'
    for (const row of page.list.slice(0, Math.min(5, Math.max(1, noteLimit)))) {
      signal?.throwIfAborted()
      if (!/^\d+$/.test(String(row.cvid))) continue
      // Date-filter attachments by their own creation time, not the video's time.
      if (!inWindow(bilibiliLocalTime(row.pubtime), row.pubtime?.length === 16 ? 59_999 : 0)) continue
      const detail = await get(api('/x/note/publish/info', { cvid: String(row.cvid) }))
      const note = publicVideoNote(row, detail, video.aid)
      if (!note) throw new Error('Public-note identity/content unavailable')
      block.notes.push(note)
    }
  } catch { signal?.throwIfAborted(); block.notes_status = 'unavailable'; stopped = true }
  if (!stopped && commentLimit) {
    try {
      signal?.throwIfAborted()
      const page = await get(api('/x/v2/reply', { type: '1', oid: String(video.aid), pn: '1', ps: '20', sort: '2' }))
      if (!Array.isArray(page.replies) && page.replies !== null) throw new Error('Comment list shape changed')
      block.comments_status = page.replies?.length ? 'sampled' : 'empty'
      for (const row of (page.replies ?? []).slice(0, Math.min(20, commentLimit))) {
        const comment = videoComment(row, bvid)
        if (comment && inWindow(comment.published)) block.comments.push(comment)
      }
    } catch { signal?.throwIfAborted(); block.comments_status = 'unavailable'; stopped = true }
  }
  const text = renderVideoBlock(block)
  return { url: block.url, title: block.title, text, published: block.published, author: plainText(video.owner?.name, 200) || null,
    video_block: block, coverage: block.coverage, stopped }
}
export function renderVideoBlock(block) {
  const header = '# ' + plainText(block.title, 500) + '\n\n## 公开笔记（主体）\n'
  const noteBudget = Math.max(100, Math.floor(4400 / Math.max(1, block.notes.length)) - 300)
  const notes = block.notes.map(note => '### ' + note.title.slice(0, 120) + '\n' + note.text.slice(0, noteBudget) + '\n作者：' + (note.author ?? '未知').slice(0, 60) + '；发布：' + (note.published ?? '未知') + '\n' + note.url).join('\n\n').slice(0, 4400)
  const noteStatus = block.notes_status === 'unavailable' ? '读取受限；已取得的笔记仍保留。' : block.notes_status === 'empty' ? '该次公开笔记列表为空。' : '有界样本；仅保留符合条件的可验证笔记。'
  const commentBudget = Math.max(20, Math.floor(2200 / Math.max(1, block.comments.length)) - 80)
  const comments = block.comments.map(comment => '- [' + comment.id.slice(0, 20) + '] ' + comment.text.slice(0, commentBudget) + ' — ' + (comment.author ?? '未知').slice(0, 20) + ' / ' + (comment.published ?? '未知')).join('\n').slice(0, 2200)
  const commentStatus = block.comments_status === 'unavailable' ? '评论读取受限。' : block.comments_status === 'disabled' ? '本次未请求评论。' : block.comments_status === 'empty' ? '该次评论列表为空。' : block.comments_status === 'not_requested' ? '前序读取停止，未请求评论。' : '热门根评论的有界样本；不代表完整评论区。'
  return header + (notes || noteStatus) + (notes && block.notes_status === 'unavailable' ? '\n' + noteStatus : '') + '\n\n## 评论（补充）\n' + (comments || commentStatus) + '\n' + commentStatus + '\n\nBV 号：' + block.bvid
}
/** Public projection accepts only documented fields and identities, never raw API data. */
export function projectVideoBlock(value, url) {
  const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url)?.[1]
  if (!bvid || value?.bvid !== bvid || value.url !== url) return undefined
  const status = input => ['sampled', 'empty', 'unavailable', 'not_requested', 'disabled'].includes(input) ? input : 'unavailable'
  return { schema_version: 1, title: plainText(value.title, 500), url, bvid, published: typeof value.published === 'string' ? value.published : null,
    notes_status: status(value.notes_status), comments_status: status(value.comments_status), coverage: plainText(value.coverage, 300),
    notes: (Array.isArray(value.notes) ? value.notes : []).slice(0, 5).flatMap(note => /^\d+$/.test(note?.cvid) ? [{ cvid: note.cvid, title: plainText(note.title, 500), text: plainText(note.text, 4000),
      url: 'https://www.bilibili.com/read/cv' + note.cvid, author: typeof note.author === 'string' ? plainText(note.author, 200) : null, published: typeof note.published === 'string' ? note.published : null,
      published_precision: ['minute', 'second'].includes(note.published_precision) ? note.published_precision : null }] : []),
    comments: (Array.isArray(value.comments) ? value.comments : []).slice(0, 20).flatMap(comment => /^\d+$/.test(comment?.id) ? [{ id: comment.id, text: plainText(comment.text, 1000), author: typeof comment.author === 'string' ? plainText(comment.author, 200) : null,
      published: typeof comment.published === 'string' ? comment.published : null, likes: Number.isSafeInteger(comment.likes) && comment.likes >= 0 ? comment.likes : 0, url: 'https://www.bilibili.com/video/' + bvid + '#reply' + comment.id }] : []) }
}
