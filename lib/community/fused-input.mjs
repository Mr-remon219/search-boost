import Ajv from 'ajv'
import { FUSED_PLATFORM_OPTIONS_SCHEMA } from './parameters.mjs'
export { FUSED_PLATFORM_OPTIONS_SCHEMA } from './parameters.mjs'
import { communityPlatforms } from './selection.mjs'
import { normalizeCommunityInput, communityDate } from './pipeline.mjs'

const validateOptions = new Ajv({ allErrors: true, strict: true }).compile(FUSED_PLATFORM_OPTIONS_SCHEMA)
const present = value => value !== undefined && value !== null

/** Pure preflight shared by fused and Adaptive, before configuration or I/O. */
export function prepareFusedCommunity({ query, community = false, platform_options, recency, limit = 30 }) {
  if (platform_options !== undefined && !validateOptions(platform_options)) throw new Error('Invalid community platform_options')
  const platforms = communityPlatforms(community)
  const options = platform_options ?? {}
  if (Object.keys(options).some(platform => !platforms.includes(platform))) throw new Error('platform_options requires an explicit matching community selection; it never enables a platform')
  if (!platforms.length) return { platforms, args: null, requests: [], softDates: {} }
  const args = { engines: platforms, type: 'keyword', query, max_results: limit,
    ...(platform_options !== undefined ? { platform_options } : {}),
  }
  // Validate caller bounds independently of a generated recall preference.
  normalizeCommunityInput(args)
  const days = { day: 1, week: 7, month: 30, year: 365 }[recency]
  if (days) {
    const hint = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    args.platform_options = Object.fromEntries(platforms.map(platform => {
      const local = { ...(options[platform] ?? {}) }, upper = communityDate(local.to_date, true)
      // A historical hard upper bound wins over the generated recall window.
      // Reddit then uses its own bounded window ending at the caller's date.
      if (!present(local.from_date) && (upper === null || upper >= Date.parse(hint))) local.from_date = hint
      return [platform, local]
    }))
  }
  const normalized = normalizeCommunityInput(args)
  // Generated recency is not a caller's hard condition for non-X. Each explicit
  // local bound remains strict independently; null cannot erase an inherited
  // bound, but a soft generated lower bound must not become hard with to_date.
  const softDates = Object.fromEntries(platforms.map(platform => [platform, {
    from: !present(options[platform]?.from_date), to: !present(options[platform]?.to_date),
  }]))
  return { platforms, args, requests: normalized.requests, softDates }
}
