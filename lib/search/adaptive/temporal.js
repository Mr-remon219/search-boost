// Conservative date gates. Never infer a publication date from an arbitrary
// date in a page, URL or title. Day-only dates have day precision, not a time.
export function strictDay(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})(?:T[^\s]+)?$/.exec(value.trim())
  if (!match) return null
  const day = match[1]
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : null
}

export function dateWindow(text, now) {
  const s = String(text)
  // 'as of' describes a knowledge cutoff, not an event occurring that day.
  if (/as of|截至|截止/i.test(s)) return null
  const today = /\btoday\b|今天|今日/i.test(s)
  const yesterday = /\byesterday\b|昨天|昨日/i.test(s)
  if (!today && !yesterday) {
    const dates = [...s.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => strictDay(m[0])).filter(Boolean).sort()
    return dates.length ? { start: dates[0], end: dates.at(-1), timeZone: 'UTC', basis: /\bpublished\b|刊登|发表的|发布的文章/i.test(s) ? 'published' : 'event' } : null
  }
  const day = new Date(now - (yesterday ? 86400000 : 0)).toISOString().slice(0, 10)
  return { start: day, end: day, timeZone: 'UTC', basis: /\bpublished\b|刊登|发表的|发布的文章/i.test(s) ? 'published' : 'event' }
}

export function inspectDates({ published, text }, window) {
  const publishedAt = strictDay(published)
  const eventDates = []
  // Keep exact dated statements as witnesses; model judgement still checks
  // whether the event is the one the target asks about, not a sidebar event.
  for (const sentence of String(text ?? '').split(/\n+|(?<=[.!?。！？])\s+/)) {
    if (!/released?|launched?|announced?|updated?|occurred|发布|上线|宣布|更新|发生/i.test(sentence)) continue
    for (const m of sentence.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
      const day = strictDay(m[0])
      if (day && !eventDates.some((d) => d.date === day && d.witness === sentence)) eventDates.push({ date: day, witness: sentence })
    }
  }
  const inWindow = (day) => day && day >= window.start && day <= window.end
  let status = 'not_required'
  if (window) {
    if (window.basis === 'published') status = !publishedAt ? 'unknown' : inWindow(publishedAt) ? 'eligible' : 'outside_window'
    else status = !eventDates.length ? 'unknown' : eventDates.some((d) => inWindow(d.date)) ? 'eligible' : 'outside_window'
  }
  return { publishedAt, publishedBasis: publishedAt ? 'search_metadata' : null, eventDates, window, status }
}
