import Ajv from 'ajv'
import * as z from 'zod'
import { COMMUNITY_PLATFORMS } from './registry.mjs'
import { COMMUNITY_ITEM_SCHEMA } from './result-schema.mjs'

import { PLATFORM_OPTIONS_SCHEMA, communityString as string, nullableCommunitySchema as nullable, communityDateSchema as date } from './parameters.mjs'
export { PLATFORM_OPTIONS_SCHEMA } from './parameters.mjs'
export const COMMUNITY_SEARCH_INPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    engines: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: COMMUNITY_PLATFORMS }, description: 'Selected platforms: Reddit, X, Bilibili, Zhihu and Xiaohongshu. Diagnostics disclose archive, public API, browser or web-index retrieval.' },
    type: { type: 'string', enum: ['keyword', 'semantic', 'user', 'thread'], description: 'Default keyword. X supports all four operations; other selected backends disclose unsupported operations. platform_options may override per platform.' },
    query: nullable(string('Common search query; user mode also accepts a handle here. May be omitted if selected platforms supply their own queries.')),
    username: string('X account handle; user identity or a verified keyword/semantic author constraint.'),
    post_id: string('X post id or status URL for thread mode; per-platform overrides live in platform_options.'),
    max_results: { type: 'integer', minimum: 1, maximum: 30, description: 'Final total result limit; default 5, max 30.' },
    subreddits: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_]{2,21}$' }, description: 'Explicit Reddit scope. Otherwise use backend scopes or bounded web-index scope discovery.' },
    max_pages: { type: 'integer', minimum: 1, maximum: 20, description: 'Reddit collector total page budget across all scopes, default 6; each page at most 100 archive posts. Private checkpoints resume on later calls.' },
    from_date: date(),
    to_date: date(),
    allowed_x_handles: { type: 'array', maxItems: 20, items: string('Allowed X author handle; mutually exclusive with excluded_x_handles.') },
    excluded_x_handles: { type: 'array', maxItems: 20, items: string('Excluded X author handle.') },
    model: string('Optional driving model for the existing hosted X path.'),
    reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
    platform_options: nullable(PLATFORM_OPTIONS_SCHEMA),
    page_size: { type: 'integer', minimum: 1, maximum: 50, description: 'Returned page size, default 5; does not change the total max_results or acquisition budget.' },
    save_results: { type: 'boolean', description: 'Explicitly save public evidence and diagnostics in a private community snapshot; default false. No backend config or credentials.' },
    cursor: string('Read an existing community result page, with optional page_size only; zero network, no reprocessing.'),
    saved_result_id: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$', description: 'Restore a private saved community snapshot; optional page_size only. Historical evidence is not refreshed.' },
  },
}
export const COMMUNITY_BACKEND_INPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'register', 'update', 'remove', 'check'] },
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$', description: 'Backend instance id. x-default is the built-in X instance.' },
    provider: { type: 'string', description: 'Implemented provider id from list. Not a package, executable or arbitrary code loader.' },
    enabled: { type: 'boolean', description: 'Enable this instance; register defaults to true. Update preserves omitted fields.' },
    config: { type: 'object', additionalProperties: false, properties: {
      subreddits: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_]{2,21}$' } },
      endpoint: { type: 'string', maxLength: 200, description: 'User-started SearchBoost loopback browser bridge origin.' },
      token_env: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,127}$', description: 'Environment variable NAME referencing a local bridge token. Never the token itself.' },
    }, description: 'Provider-specific validated config. X/public/web adapters require {}; reddit-arctic accepts subreddits; browser adapters require endpoint and token_env. No cookies, passwords or arbitrary tools.' },
  }, required: ['action'],
}
export const COMMUNITY_CHANNEL_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  platform: { type: 'string', enum: COMMUNITY_PLATFORMS },
  status: { type: 'string', enum: ['ok', 'empty', 'partial', 'failed', 'disabled', 'unavailable', 'blocked', 'unsupported', 'not_implemented', 'domain_excluded'] },
  provider: { type: 'string' }, backend: { type: 'string' }, retrieval_mode: { type: 'string', enum: ['native', 'archive', 'mixed', 'web-index'] },
  reason: { type: 'string' }, via: { type: 'string' }, cache_hit: { type: 'boolean' }, in_flight: { type: 'boolean' }, note: { type: 'string' },
  engine_stats: { type: 'object', additionalProperties: true, properties: {} },
  engines_used: { type: 'array', items: { type: 'string' } },
  execution: { type: 'object', additionalProperties: true, properties: {} }, diagnostics: { type: 'object', additionalProperties: true, properties: {} },
  warnings: { type: 'array', items: { type: 'string' } },
}, required: ['platform', 'status', 'warnings'] }
export const COMMUNITY_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    schema_version: { type: 'integer' },
    status: { type: 'string', enum: ['ok', 'empty', 'partial', 'failed'] },
    results: { type: 'integer' },
    items: { type: 'array', items: COMMUNITY_ITEM_SCHEMA },
    channels: { type: 'array', maxItems: 5, items: COMMUNITY_CHANNEL_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    took_ms: { type: 'number' },
    total_results: { type: 'integer', minimum: 0 }, page_results: { type: 'integer', minimum: 0 },
    next_cursor: { type: ['string', 'null'] }, expires_at: { type: 'string' }, saved_result_id: { type: 'string' },
    historical: { type: 'boolean' }, reused: { type: 'boolean' }, captured_at: { type: 'string' },
  }, required: ['schema_version', 'status', 'results', 'items', 'channels', 'warnings', 'took_ms'],
}
export const COMMUNITY_BACKEND_OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string' }, changed: { type: 'boolean' },
    providers: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
    backends: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
  }, required: ['action', 'changed', 'providers', 'backends'],
}
const ajv = new Ajv({ allErrors: true, strict: true })
const validators = new Map([COMMUNITY_SEARCH_INPUT, COMMUNITY_BACKEND_INPUT, COMMUNITY_OUTPUT, COMMUNITY_BACKEND_OUTPUT].map(schema => [schema, ajv.compile(schema)]))
export function validateCommunity(schema, value) {
  const check = validators.get(schema)
  if (!check || !check(value)) throw new Error(`Invalid community input/output: ${check ? ajv.errorsText(check.errors) : 'unknown schema'}`)
  return value
}

/** Small shared-schema projection, only for the schema vocabulary above. */
export function communityZod(schema) {
  let out
  if (schema.oneOf) out = z.union(schema.oneOf.map(communityZod))
  else if (Array.isArray(schema.type)) out = z.union(schema.type.map(type => communityZod({ ...schema, type })))
  else if (schema.type === 'null') out = z.null()
  else if (schema.enum) out = schema.enum.every(value => typeof value === 'string') ? z.enum([...schema.enum]) : schema.enum.length === 1 ? z.literal(schema.enum[0]) : z.union(schema.enum.map(value => z.literal(value)))
  else if (schema.type === 'object') {
    out = z.object(Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => {
      const field = communityZod(child)
      return [key, schema.required?.includes(key) ? field : field.optional()]
    })))
    out = schema.additionalProperties === false ? out.strict() : typeof schema.additionalProperties === 'object' ? out.catchall(communityZod(schema.additionalProperties)) : out.passthrough()
  } else if (schema.type === 'array') {
    out = z.array(communityZod(schema.items))
    if (schema.minItems !== undefined) out = out.min(schema.minItems)
    if (schema.maxItems !== undefined) out = out.max(schema.maxItems)
    if (schema.uniqueItems) out = out.refine(values => new Set(values).size === values.length, 'Duplicate values')
  } else if (schema.type === 'string') {
    out = z.string()
    if (schema.minLength !== undefined) out = out.min(schema.minLength)
    if (schema.maxLength !== undefined) out = out.max(schema.maxLength)
    if (schema.pattern) out = out.regex(new RegExp(schema.pattern))
  } else if (schema.type === 'boolean') out = z.boolean()
  else if (schema.type === 'integer' || schema.type === 'number') {
    out = z.number()
    if (schema.type === 'integer') out = out.int()
    if (schema.minimum !== undefined) out = out.min(schema.minimum)
    if (schema.maximum !== undefined) out = out.max(schema.maximum)
  } else throw new Error('Unsupported community schema projection')
  return schema.description ? out.describe(schema.description) : out
}

export const COMMUNITY_DESCRIPTION = 'Search Reddit, X, Bilibili, Zhihu and Xiaohongshu using SearchBoost adapters. platform_options holds independent nullable platform parameters; explicit values override common inputs. Each platform normalizes and filters its own evidence and retains versioned platform data. Direct results are snapshot pages: page_size defaults to 5 and cursor reads add zero network calls; save_results explicitly enables private persistence and saved_result_id restores historical evidence without refresh. X retains keyword/semantic/account/thread modes; Reddit uses bounded archive collection and local retrieval; Chinese platforms support explicitly configured read-only browser adapters and honest public web-index candidates, with an optional Bilibili public API. Results preserve source evidence and identify the backend, retrieval mode and partial failures. A sample or incomplete thread does not establish complete coverage or platform-wide sentiment. Search does not register, install or enable backends.'
export const COMMUNITY_BACKEND_DESCRIPTION = 'Inspect or manage local SearchBoost community backend instances. list and check are read-only configuration inspection; check currently reports readiness, not live connectivity. register, update and remove change local configuration and require user authorization. Only explicitly implemented providers can be registered; this is not a code, shell, package installation or platform login tool. Do not send cookies or tokens in arguments.'
export const formatCommunityResult = (value) => JSON.stringify(value, null, 2)
