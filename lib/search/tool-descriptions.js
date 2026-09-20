// Host-neutral tool contracts. Schemas own parameter details; inject text owns
// verification policy; optional skills/templates own multi-step workflows.
export const FETCH_DESCRIPTION =
  'Read a known public http(s) URL without searching again. Returns readable text via Jina Reader with a guarded local HTML fallback; strips CSS/JS/ad chrome. Use focus for matching paragraphs, or omit it for the readable body. A focus miss is not proof the page lacks the answer: retry without focus. Response size and network safety limits can reject a fetch. Not an authenticated browser or a private-network tool.'

export const X_DESCRIPTION =
  'Find X/Twitter posts, inspect an account, or retrieve available thread material. Use keyword/semantic with query, user with username, or thread with post_id. Credential-free retrieval is available; configured X authentication can improve coverage. Author/date filters apply across retrieval paths; candidates whose required metadata cannot be verified are omitted. Results may be incomplete, delayed or empty; a post sample does not establish platform-wide sentiment and a thread result is not guaranteed to contain the full conversation.'
