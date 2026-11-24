// Tool descriptions own purpose, result meaning and consequential limitations.
// Field details belong to schemas; transport internals belong to optional reference.
export const FETCH_DESCRIPTION = [
  'Read a known HTTP(S) URL without searching again. Returns readable HTML or locally extracted PDF text, with retrieval route and any extraction limitations.',
  'Long bodies use bounded windows; continue from nextOffset using the cached read, not a new request. A focus miss is not evidence of absence: retry without focus.',
  'Binary bodies and PDFs with no extractable text return errors, not page text. Network safety, proxy policy, cancellation and size limits remain enforced through all supported fallbacks. This is not an authenticated browser.',
].join(' ')

export const STATS_DESCRIPTION =
  'Read-only search diagnostics: cache activity, engine configuration readiness and recent searches. Inspect result warnings as well; empty results do not prove absence or authorize changing credentials, permissions or defaults.'
