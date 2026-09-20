// Default question set for scripts/eval-adaptive-search.mjs — 9 questions,
// non-sensitive, mixed languages (≥1/3 Chinese so per-language behaviour is
// visible), covering the four shapes the design cares about:
// official-documentation, comparison, time-sensitive, and long-tail/niche.
//
// Keep this list free of credentials, private URLs and anything that would send
// sensitive text to the Jev service. The evaluation is explicit opt-in.

export const DEFAULT_EVAL_QUESTIONS = [
  // official documentation
  'What is the documented signature and semantics of AbortSignal.timeout(delay) in Node.js 22?',
  'What exactly does PostgreSQL document about jsonb GIN index operator classes and when to use each?',
  // comparison
  'Compare how SQLite and DuckDB document their handling of concurrent writers and what each recommends.',
  // time-sensitive
  'Which version of the Web Platform Test suite currently documents the highest required maturity for the File System Access API, as of this year?',
  // long-tail / niche
  'Find the documented behavior of git sparse-checkout cone mode when a tracked file outside the cone is edited locally.',
  // Chinese: official documentation
  'Node.js 22 官方文档中 AbortSignal.timeout 的签名与超时语义是什么？',
  // Chinese: comparison
  '对比 PostgreSQL 与 MySQL 官方文档对 JSON 字段索引的说明，各自推荐的使用场景是什么？',
  // Chinese: time-sensitive
  '今年最新的 SQLite 版本号是多少，官方发布说明里主要变更是什么？',
  // Chinese: long-tail
  'Caddy 官方文档里关于 ACME 证书申请失败自动重试策略的说明是什么？',
]
