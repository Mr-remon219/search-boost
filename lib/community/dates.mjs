const present = value => value !== undefined && value !== null

/** Same inclusive date/timestamp semantics as X, without X identity assumptions. */
export function communityDate(value, end = false) {
  if (!present(value)) return null
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$)/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value.slice(0, 10))).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Community dates must be real YYYY-MM-DD or timezone-qualified ISO timestamps')
  return Date.parse(value) + (end && day ? 86400000 - 1 : 0)
}
