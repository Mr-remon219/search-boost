# AGENTS.md

## Cursor Cloud specific instructions

`search-boost-mcp` is a self-contained Node.js (ESM, `>=22.13`) CLI + stdio MCP server. There is
no database, Docker, or external service to run — dependencies are just the npm packages, installed
by the startup update script (`npm ci`).

### Lint / test / build / run

Standard scripts live in `package.json` (see `scripts`); prefer those. Key commands:

- Lint/syntax check: `npm run check` (syntax-checks every `.mjs`, no separate build step).
- Tests: `npm run test:install`, `npm run test:doctor`, `npm run test:fusion`, `npm run smoke`.
  `npm run smoke` spawns the MCP server over stdio and lists tools/resources/prompts — this is the
  fastest end-to-end sanity check.
- Run the MCP server (dev): `node cli.mjs serve` (alias `npm start`). It speaks MCP over stdio, so
  it has no console UI — drive it with an MCP client (see `scripts/smoke.mjs` for a minimal client).
- CLI health: `node cli.mjs doctor --quick --json`, `node cli.mjs status`.

### Non-obvious gotchas

- `node cli.mjs doctor` exits `2` (not `0`) when there are only warnings — e.g. a fresh VM with no
  API keys and no agents configured. CI treats exit `2` as success. Do not treat exit `2` as a failure.
- The `free` search layer (Bing + DuckDuckGo + Yahoo + Exa-free) needs **no API keys** and works as
  long as outbound network egress is allowed. Keyed engines (Tavily/Brave/Exa) and richer `x_search`
  are only active on the `api` layer once keys are provided via `search-boost config keys` or env
  vars (`TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `XAI_API_KEY`).
- Runtime config/state is written under `~/.search-boost/` (overridable with `SEARCH_BOOST_HOME`),
  not inside the repo.
- `npm run plugin:sync-grok` regenerates `grok-plugin/` from source; `prepublishOnly` and CI run it.
  Run it after editing shared skill/MCP templates so the vendored `grok-plugin/` copy stays in sync.
