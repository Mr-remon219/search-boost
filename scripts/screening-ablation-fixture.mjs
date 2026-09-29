// Frozen ablation fixture for the fused+Jev screening prototype.
//
// Three real fused_search candidate pools (captured 2026-09-28 from the live
// hybrid pool; B scores transcribed from the consensus-v2.1 outputs). Two label
// layers per candidate:
//   - tool: what excerpt-level review establishes (frozen screening judgement)
//   - gold: provisional development labels, NOT independently validated truth
// Full-page snapshots and a blinded annotation trail are not stored here.
// Rescue notes drive simulated reads/judgements, not live Jev measurements. `cluster` groups one document across mirrors/versioned
// URLs and is the ground truth for near-duplicate folding.
//
// gold.scope has three states, deliberately: pass (conditions established),
// unestablished (the material cannot decide — the honest state for excerpt-level
// insufficiency), and fail (established non-satisfaction or irrelevance). pass
// counts for metric gain; only fail counts as a misadmit. gold.value on non-pass
// rows is "value if it were eligible" — reported as excluded material, but
// contributes 0 to ranking gains.

export const PREFERENCE_MATCH_VALUE = { match: 1, partial: 0.5, no_match: 0, unknown: 0 }

const poolA = {
  id: 'A',
  question: 'Compare how SQLite and DuckDB document their handling of concurrent writers and what each recommends.',
  intent: 'Each project\'s own documented concurrency model and recommendation, not third-party summaries.',
  constraints: ['Material must document concurrent-writer behavior of BOTH SQLite and DuckDB.'],
  preferences: ['Prefer official project documentation over third-party blogs.'],
  candidates: [
    {
      id: 'A1', url: 'https://posthog.com/blog/duckdb-vs-sqlite', title: 'In-depth: DuckDB vs SQLite - PostHog',
      B: 2.1822855040571345, engines: ['anysearch', 'brave', 'tavily'], cluster: 'posthog-duckdb-sqlite',
      text: 'This contrast can also be felt in the tradeoffs. SQLite forgoes concurrency with its single writer architecture, while databases like Postgres or MySQL can handle thousands of concurrent writers. Meanwhile, DuckDB has a similar analytical p',
      gold: { scope: 'pass', value: 3, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'A2', url: 'https://www.dbpro.app/blog/duckdb-vs-sqlite', title: 'DuckDB vs SQLite: Choose the Right Embedded Database - DB Pro Blog',
      B: 1.6589814414439623, engines: ['brave', 'tavily'], cluster: 'dbpro-duckdb-sqlite',
      text: 'SQLite\'s own when-to-use guidance recommends a client-server database for many concurrent writers or direct access across a network. DuckDB\'s native read-write mode centres on one process.',
      gold: { scope: 'pass', value: 4, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 4, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'A3', url: 'https://www.datacamp.com/blog/duckdb-vs-sqlite-complete-database-comparison', title: 'DuckDB vs SQLite: A Complete Database Comparison',
      B: 1.585784284831747, engines: ['anysearch', 'brave'], cluster: 'datacamp-duckdb-sqlite',
      text: 'DuckDB vs SQLite: A Complete Database Comparison. Learn the main differences between SQLite and DuckDB and how they compare with each other.',
      gold: { scope: 'unestablished', value: null, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 'unestablished', pref: 'no_match' },
      rescue: { status: 'read_failed', note: 'HTTP 403: no new judgement; scope-pass candidate is not eligible for scope rescue' },
    },
    {
      id: 'A4', url: 'https://motherduck.com/learn/duckdb-vs-sqlite-databases', title: 'DuckDB vs SQLite: Which Embedded Database Should You Use? | MotherDuck',
      B: 1.4357424044663165, engines: ['brave', 'tavily'], cluster: 'motherduck-duckdb-sqlite',
      text: 'Both SQLite and DuckDB are embedded databases, meaning they do not scale out across multiple nodes or machines out of the box. However, DuckDB\'s multi-threaded query execution allows it to utilize multiple CPU cores for parallel processin',
      gold: { scope: 'pass', value: 3, pref: 'partial' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'partial' }, rescue: null,
    },
    {
      id: 'A5', url: 'https://duckdb.org/docs/current/core_extensions/sqlite', title: 'sqlite | DuckDB',
      B: 1.2667622912488774, engines: ['exa', 'exa-free'], cluster: 'duckdb-sqlite-ext',
      text: 'Search Shortcut cmd + k | ctrl + k - Installation - Documentation Getting Started Connect Overview Concurrency Data Import and Export Overview Data Sources CSV Files Overview Auto Detection Reading Faulty CSV Files',
      gold: { scope: 'pass', value: 3, pref: 'match' },
      tool: { scope: 'not_passed', info: 'insufficient_information', value: 'unestablished', pref: 'match' },
      rescue: { status: 'read', scope: 'pass', info: 'established', value: 3, pref: 'match', note: 'full page Concurrency section: single-writer locking for SQLite files accessed from DuckDB or SQLite, locking handled by the SQLite library' },
    },
    {
      id: 'A6', url: 'https://sqlite.org/hctree/doc/begin-concurrent/doc/begin_concurrent.md', title: 'hctree: Begin Concurrent',
      B: 1.050584021385379, engines: ['exa', 'exa-free'], cluster: 'sqlite-begin-concurrent',
      text: 'Usually, SQLite allows at most one writer to proceed concurrently. The BEGIN CONCURRENT enhancement allows multiple writers to process write transactions simultanously if the database is in wal or wal2 mode',
      gold: { scope: 'unestablished', value: 5, pref: 'match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'A7', url: 'https://duckdb.org/docs/lts/connect/concurrency', title: 'https://duckdb.org/docs/lts/connect/concurrency',
      B: 1.1449494965432279, engines: ['exa', 'exa-free'], cluster: 'duckdb-concurrency',
      text: 'Search Shortcut cmd + k | ctrl + k - Installation - Documentation Getting Started Connect Overview Concurrency Data Import and Export Overview Data Sources CSV Files Overview Auto Detection',
      gold: { scope: 'unestablished', value: 5, pref: 'match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'A8', url: 'https://dbapark.com/sqlite-vs-duckdb-embedded-database/', title: 'SQLite vs DuckDB: Which Embedded Database Should You Choose?',
      B: 1.0326370037108423, engines: ['anysearch'], cluster: 'dbapark-sqlite-duckdb',
      text: 'DuckDB supports transactions and persistent tables, but its architecture is optimized for analytical processing. If the application constantly updates individual rows under concurrent request load, benchmark carefully and consider SQLite or',
      gold: { scope: 'pass', value: 3, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'A9', url: 'https://ejje.weblio.jp/content/compare', title: '英語「 compare 」の意味・使い方・読み方 | Weblio英和辞書',
      B: 0.9709060186518813, engines: ['bing'], cluster: 'weblio-compare',
      text: '2023年12月25日 ... (transitive) To assess the similarities and differences between two or more things ["to compare X with Y"]',
      gold: { scope: 'fail', value: 0, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'explicit_conflict', value: 0, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'A10', url: 'https://www.sqlite.org/lockingv3.html', title: 'File Locking And Concurrency In SQLite Version 3',
      B: 0.9675117038555022, engines: ['exa', 'exa-free'], cluster: 'sqlite-locking-v3',
      text: 'File Locking And Concurrency In SQLite Version 3 ... an authoritative reference to how database file locking works in SQLite version 3. The document only describes locking for the older rollback-mode transaction mechanism.',
      gold: { scope: 'unestablished', value: 5, pref: 'match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 5, pref: 'match' }, rescue: null,
    },
  ],
}

const poolB = {
  id: 'B',
  question: 'What is the documented signature and semantics of AbortSignal.timeout(delay) in Node.js 22?',
  intent: 'The exact signature, timeout semantics, and version availability of AbortSignal.timeout in Node.js.',
  constraints: ['Material must document AbortSignal.timeout as available in Node.js version 22 (v22 documentation or explicit version history establishing availability in v22).'],
  preferences: ['Prefer official Node.js documentation.'],
  candidates: [
    {
      id: 'B1', url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static', title: 'AbortSignal: timeout() static method - Web APIs | MDN',
      B: 2.4008774778479016, engines: ['anysearch', 'brave', 'exa', 'tavily'], cluster: 'mdn-timeout-static',
      text: 'The AbortSignal.timeout() static method returns an AbortSignal that will automatically abort after a specified time. The signal aborts with a TimeoutError DOMException on timeout.',
      gold: { scope: 'unestablished', value: 4, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 4, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'B2', url: 'https://nodejs.org/api/globals.html', title: 'Global objects | Node.js v26.10.0 Documentation',
      B: 2.3506557937841097, engines: ['anysearch', 'brave', 'exa-free', 'tavily'], cluster: 'nodejs-globals-current',
      text: 'Triggers the abort signal, causing the abortController.signal to emit the \'abort\' event. Returns a new AbortSignal which will be aborted in delay milliseconds.',
      gold: { scope: 'pass', value: 4, pref: 'match' },
      tool: { scope: 'not_passed', info: 'insufficient_information', value: 'unestablished', pref: 'match' },
      rescue: { status: 'read', scope: 'pass', info: 'established', value: 4, pref: 'match', note: 'full page shows "AbortSignal.timeout(delay) Added in: v17.3.0, v16.14.0" — version history establishes availability in v22' },
    },
    {
      id: 'B3', url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal', title: 'AbortSignal - Web APIs | MDN',
      B: 2.030190633219715, engines: ['brave', 'exa', 'tavily'], cluster: 'mdn-abortsignal',
      text: 'AbortSignal.any()") : Returns an AbortSignal that aborts when any of the given abort signals aborts. AbortSignal.timeout()") : Returns an AbortSignal instance that will automatically abort after a specified time.',
      gold: { scope: 'unestablished', value: 3, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'B4', url: 'https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html', title: 'AbortController in Node.js: Cancel Async Operations | AppSignal Blog',
      B: 1.7251718689059545, engines: ['anysearch', 'brave', 'tavily'], cluster: 'appsignal-abortcontroller',
      text: 'This pattern of canceling network requests after a fixed timeout is so common that a static timeout() method was added to the AbortSignal interface to simplify such cases',
      gold: { scope: 'unestablished', value: 4, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'insufficient_information', value: 'unestablished', pref: 'no_match' },
      rescue: { status: 'read', scope: 'not_passed', info: 'unestablished_reason', value: 4, pref: 'no_match', note: 'full page read: practical TimeoutError semantics but no version pin anywhere — v22 availability still not established; correctly stays excluded' },
    },
    {
      id: 'B5', url: 'https://beta.docs.nodejs.org/globals/AbortSignal', title: 'AbortSignal | Node.js 26.8.2 Documentation',
      B: 1.5769485952521662, engines: ['brave', 'exa', 'exa-free'], cluster: 'nodejs-abortsignal-beta',
      text: 'AbortSignal.timeout History Added in: v17.3.0, v16.14.0 v17.3.0, v16.14.0 AbortSignal.timeout(delay): void delay:number The number of milliseconds to wait before triggering the AbortSignal. Returns a new AbortSignal which will be aborted in delay milliseconds.',
      gold: { scope: 'pass', value: 4, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 4, pref: 'match' }, rescue: null,
    },
    {
      id: 'B6', url: 'https://nearform.com/insights/using-abortsignal-in-node-js/', title: 'Using AbortSignal in Node.js | NearForm',
      B: 1.3978788037272862, engines: ['brave', 'tavily'], cluster: 'nearform-abortsignal',
      text: 'To correctly handle this pattern, we need a reliable mechanism for signalling across the two promises, canceling either the timer or the long-running task as appropriate',
      gold: { scope: 'unestablished', value: 2, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 2, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'B7', url: 'https://stackoverflow.com/questions/75758154/how-to-fix-conflicting-abortsignal-in-node-modules-types-node-globals-d-ts-and', title: 'How to fix conflicting AbortSignal in node_modules/@types/node/globals.d.ts',
      B: 1.3294757232298378, engines: ['anysearch', 'tavily'], cluster: 'so-types-conflict',
      text: 'node_modules/@types/node/globals.d.ts:72:13 - error TS2023: Subsequent variable declarations must have the same type of variable \'AbortSignal\'',
      gold: { scope: 'fail', value: 1, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'explicit_conflict', value: 1, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'B8', url: 'https://openjsf.org/blog/using-abortsignal-in-node-js', title: 'Using AbortSignal in Node.js',
      B: 1.2991519674098142, engines: ['anysearch', 'tavily'], cluster: 'nearform-abortsignal',
      text: 'The timer keeps running, and the promise will end up rejecting, still with an unhandled rejection — unnecessarily risking performance issues',
      gold: { scope: 'unestablished', value: 2, pref: 'no_match' },
      tool: { scope: 'not_passed', info: 'unestablished_reason', value: 2, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'B9', url: 'https://nodejs.org/download/release/v22.12.0/docs/api/globals.html', title: 'Global objects | Node.js v22.12.0 Documentation',
      B: 1.3034162927317734, engines: ['exa', 'exa-free'], cluster: 'nodejs-globals-v22',
      text: 'Static method: AbortSignal.timeout(delay)# Added in: v17.3.0, v16.14.0 - delay The number of milliseconds to wait before triggering the AbortSignal. Returns a new AbortSignal which will be aborted in delay milliseconds.',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'B10', url: 'https://nodejs.org/download/release/v22.2.0/docs/api/globals.html', title: 'Global objects | Node.js v22.2.0 Documentation',
      B: 1.1676349760784668, engines: ['exa', 'exa-free'], cluster: 'nodejs-globals-v22',
      text: 'Static method: AbortSignal.timeout(delay)# Added in: v17.3.0, v16.14.0 - delay The number of milliseconds to wait before triggering the AbortSignal.',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
  ],
}

const poolC = {
  id: 'C',
  question: 'Find the documented behavior of git sparse-checkout cone mode when a tracked file outside the cone is edited locally.',
  intent: 'The documented mechanism for tracked files outside the cone (SKIP_WORKTREE, working-tree removal) and related cone-mode behavior.',
  constraints: ['Material must document git sparse-checkout cone-mode behavior.'],
  preferences: ['Prefer official Git documentation.'],
  candidates: [
    {
      id: 'C1', url: 'https://git-scm.com/docs/git-sparse-checkout', title: 'Git - git-sparse-checkout Documentation',
      B: 2.630278137872106, engines: ['anysearch', 'brave', 'exa', 'exa-free', 'tavily'], cluster: 'git-sparse-checkout-man',
      text: 'When changing the sparse-checkout patterns in cone mode, Git will inspect each tracked directory that is not within the sparse-checkout cone to see if it contains any untracked files. If all of those files are ignored due to the .gitignore',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'C2', url: 'https://git-scm.com/docs/sparse-checkout', title: 'Git - sparse-checkout Documentation',
      B: 2.1369594347809175, engines: ['brave', 'exa', 'exa-free', 'tavily'], cluster: 'git-sparse-checkout-config',
      text: 'In cone-mode, the user specifies ... tracked files do not match the sparse specification and are removed from the working tree, the file in the index is marked with a SKIP_WORKTREE bit',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'C3', url: 'https://www.kernel.org/pub/software/scm/git/docs/git-sparse-checkout.html', title: 'git-sparse-checkout(1)',
      B: 2.0026843795437426, engines: ['anysearch', 'brave', 'exa', 'exa-free'], cluster: 'git-sparse-checkout-man',
      text: 'When changing the sparse-checkout patterns in cone mode, Git will inspect each tracked directory that is not within the sparse-checkout cone to see if it contains any untracked files. If all of those files are ignored due to the .gitignore',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'C4', url: 'https://man.archlinux.org/man/git-sparse-checkout.1.en', title: 'git-sparse-checkout(1) — Arch manual pages',
      B: 1.9552000605330369, engines: ['brave', 'exa', 'tavily'], cluster: 'git-sparse-checkout-man',
      text: 'When changing the sparse-checkout patterns in cone mode, Git will inspect each tracked directory that is not within the sparse-checkout cone to see if it contains any untracked files. If all of those files are ignored due to the .gitignore',
      gold: { scope: 'pass', value: 4, pref: 'partial' },
      tool: { scope: 'pass', info: 'established', value: 4, pref: 'partial' }, rescue: null,
    },
    {
      id: 'C5', url: 'https://gitperf.com/chapter-10.html', title: 'Chapter 10: Sparse-Checkout and Sparse-Index | High Performance Git',
      B: 1.7300170066609093, engines: ['anysearch', 'brave', 'tavily'], cluster: 'gitperf-sparse-chapter',
      text: 'everything under that directory files immediately under leading directories files at the root level as part of the cone behavior Cone mode behaves well for real development trees.',
      gold: { scope: 'pass', value: 3, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'C6', url: 'https://github.blog/open-source/git/bring-your-monorepo-down-to-size-with-sparse-checkout/', title: 'Bring your monorepo down to size with sparse-checkout - The GitHub Blog',
      B: 1.6892537248439872, engines: ['anysearch', 'brave', 'tavily'], cluster: 'github-sparse-blog',
      text: 'When Git is evaluating which files match the sparse-checkout patterns, it inspects the files in a sorted order. This means that when the start of a folder matches a recursive pattern exactly, Git marks everything in that folder as included',
      gold: { scope: 'pass', value: 3, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'C7', url: 'https://stackoverflow.com/questions/9572407/git-sparse-checkout-with-exclusion', title: 'Git sparse checkout with exclusion - Stack Overflow',
      B: 1.357619814965096, engines: ['anysearch', 'brave'], cluster: 'so-sparse-exclusion',
      text: 'A cone mode skips whole directories when included or excluded: so excluding a single file like heavy_presentation inside presentations/ still',
      gold: { scope: 'pass', value: 2, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 2, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'C8', url: 'https://www.mslinn.com/git/600-partial-clone.html', title: 'Partial Clone With Sparse Checkout',
      B: 1.2974714223114288, engines: ['anysearch', 'tavily'], cluster: 'mslinn-partial-clone',
      text: 'When changing the sparse-checkout patterns in cone mode, Git will inspect each tracked directory that is not within the sparse-checkout cone to see if it contains any untracked files. If all of those files are ignored due to the .gitignore',
      gold: { scope: 'pass', value: 3, pref: 'no_match' },
      tool: { scope: 'pass', info: 'established', value: 3, pref: 'no_match' }, rescue: null,
    },
    {
      id: 'C9', url: 'https://git-scm.com/docs/git-sparse-checkout/2.55.0', title: 'Git - git-sparse-checkout Documentation',
      B: 1.1839818657435652, engines: ['exa', 'exa-free'], cluster: 'git-sparse-checkout-man',
      text: 'Changes in the git-sparse-checkout manual ... git-sparse-checkout - Reduce your working tree to a subset of tracked files ... The subset of files is chosen by providing a list of directories in cone mode',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
    {
      id: 'C10', url: 'https://code.googlesource.com/git/+/HEAD/Documentation/git-sparse-checkout.adoc', title: 'Documentation/git-sparse-checkout.adoc - git - Git at Google',
      B: 1.0456484880658776, engines: ['exa', 'exa-free'], cluster: 'git-sparse-checkout-man',
      text: 'Documentation/git-sparse-checkout.adoc - git - Git at Google ... The cone mode, which is the default, lets you specify only what directories to include',
      gold: { scope: 'pass', value: 5, pref: 'match' },
      tool: { scope: 'pass', info: 'established', value: 5, pref: 'match' }, rescue: null,
    },
  ],
}

export const POOLS = [poolA, poolB, poolC]
