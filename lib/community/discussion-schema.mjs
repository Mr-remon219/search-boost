const text = { type: 'string' }, maybeText = { type: ['string', 'null'] }, count = { type: 'integer', minimum: 0 }, maybeCount = { type: ['integer', 'null'], minimum: 0 }, flag = { type: 'boolean' }
const kinds = { type: 'string', enum: ['note', 'question', 'answer', 'article'] }
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
export const DISCUSSION_SCHEMA = object({
  schema_version: { type: 'integer', enum: [1] }, target_kind: { type: 'string', enum: ['note', 'question', 'article'] }, target_id: text, target_url: text,
  scope: { type: 'string', enum: ['accessible_to_current_session'] }, status: { type: 'string', enum: ['complete', 'partial'] }, stop_reason: maybeText, pages: count,
  sections: { type: 'array', items: object({ kind: { type: 'string', enum: ['answers', 'comments', 'replies'] }, entity_kind: kinds, entity_id: text, root_id: maybeText, complete: flag, stop_reason: maybeText, expected_count: maybeCount, collected_count: count }) },
  entities: { type: 'array', items: object({ id: text, kind: { type: 'string', enum: ['question', 'answer', 'article'] }, url: text, title: text, text, author: maybeText, published: maybeText, body_complete: flag, expected_comments: maybeCount }) },
  comments: { type: 'array', items: object({ id: text, entity_kind: kinds, entity_id: text, root_id: text, parent_id: maybeText, url: text, text, author: maybeText, published: maybeText, body_complete: flag }) },
})
