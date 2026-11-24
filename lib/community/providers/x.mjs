export const existingXProvider = {
  id: 'existing-x', platform: 'x', label: 'SearchBoost existing X pipeline', version: 1,
  operations: ['keyword', 'semantic', 'user', 'thread'], retrievalMode: 'mixed',
  validateConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length) {
      throw new Error('existing-x accepts no extra config; use existing SearchBoost X credential management')
    }
    return {}
  },
  describeAvailability({ x } = {}) {
    if (x?.blocked) return { ready: false, reason: 'X blocked by host authorization' }
    const ready = x === undefined || Boolean(x?.official?.available || x?.fallback?.available !== false)
    return { ready, reason: ready ? 'Configuration readiness only; coverage may be incomplete' : 'No configured X retrieval path' }
  },
  async search(args, context) {
    if (typeof context.xSearch !== 'function') throw new Error('X runtime not supplied')
    const { engines: _engines, subreddits: _scopes, max_pages: _pages, ...xArgs } = args
    return context.xSearch({ ...xArgs, ...context.xOptions }, { signal: context.signal, snapshot: context.snapshot, candidateMode: context.candidateMode === true, communityMode: true })
  },
}
