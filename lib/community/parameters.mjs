// Dependency-free contracts: routing/installation can inspect parameters
// without loading search validators, providers or third-party packages.
export const communityString = description => ({ type: 'string', minLength: 1, maxLength: 2000, description })
export const nullableCommunitySchema = schema => ({ oneOf: [schema, { type: 'null' }], description: `${schema.description ?? 'Optional platform condition.'} null/omitted uses the inherited value or platform default.` })
const string = communityString, nullable = nullableCommunitySchema
export const communityDateSchema = () => nullable(string('Date or timezone-qualified ISO timestamp; inclusive bounds.'))
const commonPlatformFields = () => ({
  query: nullable(string('Platform query; overrides the common query.')),
  type: nullable({ type: 'string', enum: ['keyword', 'semantic', 'user', 'thread'], description: 'Platform operation. Unsupported backend operations are disclosed, not silently downgraded.' }),
  from_date: communityDateSchema(), to_date: communityDateSchema(),
})
const authorList = () => nullable({ type: 'array', maxItems: 20, uniqueItems: true, items: string('Reddit username, not a display name or profile URL.'), description: 'Verified Reddit author identities; missing identity fails closed.' })
export const PLATFORM_OPTIONS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    x: nullable({ type: 'object', additionalProperties: false, properties: { ...commonPlatformFields(),
      username: nullable(string('X account handle.')), post_id: nullable(string('X post id or status URL.')),
      allowed_x_handles: nullable({ type: 'array', maxItems: 20, items: string('Allowed X handle.') }),
      excluded_x_handles: nullable({ type: 'array', maxItems: 20, items: string('Excluded X handle.') }),
      model: nullable(string('Hosted X model.')), reasoning_effort: nullable({ type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'] }),
    } }),
    reddit: nullable({ type: 'object', additionalProperties: false, properties: { ...commonPlatformFields(),
      subreddits: nullable({ type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_]{2,21}$' } }),
      max_pages: nullable({ type: 'integer', minimum: 1, maximum: 20, description: 'Archive acquisition page budget, default 6; not result pagination.' }),
      allowed_authors: authorList(), excluded_authors: authorList(),
    } }),
    ...Object.fromEntries([['bilibili', ['video', 'article', 'post']], ['zhihu', ['question', 'answer', 'article']], ['xiaohongshu', ['note']]].map(([platform, types]) => [platform,
      nullable({ type: 'object', additionalProperties: false, properties: { ...commonPlatformFields(), content_type: nullable({ type: 'string', enum: types, description: 'Verified platform content category; null means no category restriction.' }) } }),
    ])),
  }, description: 'Independent selected-platform parameters. Non-null values override common fields; null inherits/defaults. No credentials or endpoints.',
}
export const FUSED_PLATFORM_OPTIONS_SCHEMA = {
  ...nullable(PLATFORM_OPTIONS_SCHEMA),
  description: 'Independent nullable parameters for explicitly selected community platforms; same contract as community_search.platform_options. Requires a matching community selection for nonempty options. Defaults inherit the Web query; only caller-supplied platform queries override it, never model expansion. No community pagination, credentials or backend changes.',
}
