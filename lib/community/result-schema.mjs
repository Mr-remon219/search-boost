import { DISCUSSION_SCHEMA } from './discussion-schema.mjs'

const text = { type: 'string' }
const maybeText = { type: ['string', 'null'] }
const number = { type: 'number' }
const strings = { type: 'array', items: text }
const ranks = { type: 'object', additionalProperties: { type: 'integer', minimum: 1 }, properties: {} }
const provenance = { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
  engine: text, rank: { type: 'integer', minimum: 1 }, url: text, title: text, snippet: text, published: maybeText,
  platform: text, provider: text, backend: text, retrieval_mode: text, content_type: text,
}, required: ['engine', 'rank'] } }
const xFields = { id: text, username: text, author: maybeText, text, created_at: text, likes: number, reposts: number, replies: number, views: number,
  lang: text, media: strings, in_reply_to: text, name: text, bio: text, followers: number, following: number, verified: { type: 'boolean' } }
const recentPosts = { type: 'array', items: { type: 'object', additionalProperties: false,
  properties: { ...xFields, url: text, engines: strings, engineRanks: ranks, provenance }, required: ['id', 'text', 'url'] } }
const attachmentStatus = { type: 'string', enum: ['sampled', 'empty', 'unavailable', 'not_requested', 'disabled'] }
export const BILIBILI_VIDEO_BLOCK_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  schema_version: { type: 'integer', enum: [1] }, title: text, url: text, bvid: text, published: maybeText,
  notes_status: attachmentStatus, comments_status: attachmentStatus, coverage: text,
  notes: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, properties: { cvid: text, title: text, text, url: text, author: maybeText, published: maybeText, published_precision: { oneOf: [{ type: 'string', enum: ['minute', 'second'] }, { type: 'null' }] } }, required: ['cvid', 'title', 'text', 'url', 'author', 'published'] } },
  comments: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, properties: { id: text, text, url: text, author: maybeText, published: maybeText, likes: number }, required: ['id', 'text', 'url', 'author', 'published', 'likes'] } },
}, required: ['schema_version', 'title', 'url', 'bvid', 'published', 'notes', 'comments', 'notes_status', 'comments_status', 'coverage'] }
export const PLATFORM_DATA_SCHEMA = { oneOf: [
  ['x', ['post', 'account'], { ...xFields, recent_posts: recentPosts }],
  ['reddit', ['post'], { id: text, subreddit: text, author: maybeText, text, created_utc: number, retrieved_on: { type: ['number', 'null'] } }],
  ['bilibili', ['video', 'article', 'post'], { content_id: maybeText, author: maybeText, title: text, text, published: maybeText, video_block: BILIBILI_VIDEO_BLOCK_SCHEMA }],
  ['zhihu', ['question', 'answer', 'article'], { question_id: maybeText, answer_id: maybeText, article_id: maybeText, author: maybeText, title: text, text, published: maybeText, discussion: DISCUSSION_SCHEMA }],
  ['xiaohongshu', ['note'], { note_id: maybeText, author: maybeText, title: text, text, published: maybeText, discussion: DISCUSSION_SCHEMA }],
].map(([platform, kinds, fields]) => ({ type: 'object', additionalProperties: false,
  properties: { schema_version: { type: 'integer', enum: [1] }, platform: { type: 'string', enum: [platform] }, kind: { type: 'string', enum: kinds }, ...fields },
  required: ['schema_version', 'platform', 'kind'],
})) }
export const COMMUNITY_ITEM_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  url: text, title: text, text, published: maybeText, author: maybeText,
  platform: { type: 'string', enum: ['reddit', 'x', 'bilibili', 'zhihu', 'xiaohongshu'] }, provider: text, backend: text,
  retrieval_mode: { type: 'string', enum: ['native', 'archive', 'mixed', 'web-index'] }, content_type: text,
  engineRanks: ranks, provenance, engines: strings, coverage: text, data: PLATFORM_DATA_SCHEMA,
  ...xFields, recent_posts: recentPosts, subreddit: text, created_utc: number, retrieved_on: { type: ['number', 'null'] },
}, required: ['url', 'platform', 'provider', 'backend', 'retrieval_mode', 'content_type', 'data'] }
