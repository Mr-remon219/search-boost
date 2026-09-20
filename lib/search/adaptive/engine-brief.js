// What Jev is told about each engine — derived from what THIS repository
// actually sends and supports, not from a vendor feature list. Every trait is
// traceable to lib/search/engines.js (request shape), lib/search/fusion.js and
// lib/search/routing.js (which parameters reach the engine).
//
// Two layers:
//   1. STATIC_TRAITS  — fixed per engine, written by hand next to the code
//   2. engineBrief()  — static traits + live availability from a runtime
//                       snapshot, restricted to the user's current layer.

const STATIC_TRAITS = {
  bing: {
    kind: 'html-index',
    cost: 'free',
    text: 'title and short snippet only',
    traits: [
      'keyless HTML scrape of a broad keyword index',
      'strong for exact terms, error strings, product names',
      'no server-side host filter; a site: hint is folded into the query text',
      'no date filter; only a sparse news date is returned when present',
      'returns no page body, so the snippet may need fetch_page',
    ],
  },
  ddg: {
    kind: 'html-index',
    cost: 'free',
    text: 'title and short snippet only',
    traits: [
      'keyless HTML scrape, independent index from bing',
      'good for exact terms and long-tail pages',
      'no server-side host filter; a site: hint is folded into the query text',
      'no date filter and no publication date returned',
      'returns no page body',
    ],
  },
  yahoo: {
    kind: 'html-index',
    cost: 'free',
    text: 'title and short snippet only',
    traits: [
      'keyless HTML scrape, a third independent index',
      'no server-side host filter; a site: hint is folded into the query text',
      'no date filter and no publication date returned',
      'returns no page body',
    ],
  },
  'exa-free': {
    kind: 'neural',
    cost: 'free',
    text: 'title plus up to 240 characters of highlights',
    traits: [
      'keyless neural/semantic retrieval through Exa\'s hosted MCP tool',
      'strong for conceptual and long-tail pages that share no keywords',
      'no server-side host filter and no date filter this client sends',
      'returns highlight text, not the page body',
    ],
  },
  tavily: {
    kind: 'api',
    cost: 'paid',
    text: 'snippet, plus a fuller extraction when depth=advanced',
    traits: [
      'keyed API, consumes the user\'s Tavily quota',
      'server-side include/exclude host lists (this client sends up to 5 each)',
      'server-side recency window (time_range)',
      'depth=advanced returns a fuller page extraction this repository keeps as engine content',
    ],
  },
  brave: {
    kind: 'api',
    cost: 'paid',
    text: 'title and description snippet only',
    traits: [
      'keyed API, consumes the user\'s Brave quota',
      'server-side freshness window (day/week/month/year)',
      'no server-side host filter; a site: hint is folded into the query text',
      'returns no page body',
    ],
  },
  exa: {
    kind: 'neural',
    cost: 'paid',
    text: 'snippet plus the page text this client requests',
    traits: [
      'keyed API, consumes the user\'s Exa quota',
      'neural/semantic retrieval',
      'server-side startPublishedDate window',
      'requests page text and returns it as engine content',
    ],
  },
}

/** Engines this repository can actually call, in stable order (lib/search/engines.js). */
export const ENGINE_NAMES = ['bing', 'ddg', 'yahoo', 'exa-free', 'tavily', 'brave', 'exa']

export function engineTraits(name) {
  const entry = STATIC_TRAITS[name]
  if (!entry) return null
  return { name, ...entry }
}

/**
 * Candidate engines for one call: the user's current layer pool (so a free
 * layer never offers paid engines, and disabled or key-less engines never
 * appear), intersected with live availability, in repository order.
 *
 * This is configuration readiness — it is not a connectivity guarantee.
 *
 * @param {{ capability?: { defaultEnginePool?: string, pools?: Record<string, string[]>, availableEngines?: string[] } }} snapshot
 */
export function engineCandidates(snapshot) {
  const capability = snapshot?.capability ?? {}
  const pool = capability.defaultEnginePool ?? 'free'
  const inPool = capability.pools?.[pool] ?? []
  const available = new Set(capability.availableEngines ?? [])
  return ENGINE_NAMES.filter((name) => inPool.includes(name) && available.has(name))
}

/**
 * Structured engine brief for Jev state. `state_path` is the exact path the
 * question instructions point at, so the model is not asked to resolve a bare
 * name. Availability is described for what it is.
 */
export function engineBrief(candidates, { unavailable = [] } = {}) {
  return candidates.map((name, index) => {
    const entry = engineTraits(name)
    return {
      state_path: `state.engines[${index}]`,
      name,
      kind: entry.kind,
      cost: entry.cost,
      available: true,
      returns_text: entry.text,
      traits: entry.traits,
    }
  }).concat(unavailable.map((name) => {
    const entry = engineTraits(name)
    return {
      state_path: null,
      name,
      kind: entry?.kind ?? 'unknown',
      cost: entry?.cost ?? 'unknown',
      available: false,
      returns_text: entry?.text ?? null,
      traits: entry?.traits ?? [],
      note: 'not available in the current layer/configuration; it cannot be selected',
    }
  }))
}
