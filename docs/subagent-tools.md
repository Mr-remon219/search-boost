# SearchBoost tools in child agents

A tool allowlist does **not** load a plugin. A parent having a tool is not, by
itself, evidence that a child has it.

## Pi

There are two different launch paths:

- SearchBoost's `search-parallel-subagent` explicitly loads `adapters/pi/index.js`
  for searchers and allows `fused_search,fetch_page`. Summarizers use `--no-tools`.
- General `pi-subagents` roles such as `reviewer` and `delegate` use that package's
  extension and tool configuration. When `subagents.defaultExtensions` or an
  agent's `extensions` list is explicit, it replaces ambient extension discovery.
  Keep the SearchBoost **extension entry** in that list (or the child-only list),
  in addition to the tool names in the role's `tools` list.

For an existing SearchBoost installation at `/path/to/search-boost`, the entry is
`/path/to/search-boost/adapters/pi/index.js`, **not** the retired
`pi-search-boost/index.ts`. Preserve other extension entries, especially model
providers. Do not add SearchBoost to a deliberately empty/disabled child profile
without the owner's decision.

`deep_research` has been retired. `adaptive_search` accepts a different input
contract and uses the configured Jev service; it is not a drop-in alias. Remove
obsolete `deep_research` requirements and explicitly opt into `adaptive_search`
only when that capability is wanted. Ordinary search uses `fused_search` and
`fetch_page`; X search uses `x_search`.

### Migration and diagnosis

`search-boost install -t pi` and `search-boost upgrade --sync-only` repair existing
owned child-extension references in:

- `subagents.defaultExtensions` and `defaultSubagentOnlyExtensions`;
- `subagents.agentOverrides` and `agentOverridesByProvider`, including per-role
  `extensions`, `subagentOnlyExtensions`, and path-like entries in `tools`.

They remove `deep_research` from role allowlists only when the settings already
reference SearchBoost through that role or shared child-extension configuration.
They do not add `adaptive_search`, expand allowlists, change model defaults,
remove deny rules, or fill empty extension lists. Unrelated entries remain intact.
The exact retired npm entry under that Pi scope is recognized even after the old
package has been removed; arbitrary similarly named files are not claimed.
Upgrade includes settings changes in its existing backup/rollback transaction.
Upgrade discovery requires an existing top-level Pi package/extension, legacy
extension directory, or owned shim. If only stale child references remain, use
`search-boost install -t pi` when installation is wanted; otherwise remove those
references manually. A role with only a retired tool name and no owned SearchBoost
reference also needs manual review rather than an automatic tool rewrite.

**Uninstall boundary:** `search-boost uninstall -t pi` currently removes the
parent registration and owned workflow files, not custom `subagents.*` entries.
Remove explicit SearchBoost child-extension references and their required tool
names yourself when uninstalling; otherwise children can still load the plugin,
or fail after its package files are removed. This migration does not change that
pre-existing uninstall behavior.

`search-boost doctor --category agents` includes `pi_subagent_tools`: a read-only
check for missing owned child-extension paths, retired tool requirements, and
explicit role extension lists that omit SearchBoost. This is a **static** check,
not proof of live loading, model credentials, effective permissions, or network
connectivity. It checks user and current-project settings separately, not a full
Pi configuration merge. Custom agent Markdown, dynamically registered agents,
and other projects must be checked separately. Reload/restart Pi after repairs
and verify a real child run's tool registry and terminal result.

## DeepSeek Harness (DSH)

The default native `spawn` provider creates a fresh Agent on the same Cordis
context. It does not start a separate Pi process or read Pi child-extension
paths. The child joins its parent's preset; tool restrictions still apply.
SearchBoost registers `fused_search` and `fetch_page` through `ctx.tools`, and
`research_parallel` supplies those names in the searcher's `toolFilter.allow`.
Summarizers request an empty allowlist.

A loaded bundle alone is not enough when `fusedSearch: false`, `fetchPage: false`,
a registration failure, or host restrictions hide a required tool. Before a
searcher wave, `research_parallel` checks `ctx.tools.get(name, parentAgent)` and
refuses to spawn if either tool is absent. When a native provider exposes a local
child Agent, its scoped registry is checked too; a missing tool makes that task
fail and its handle is disposed. A summarizer-only wave needs neither search
tool. These checks do not enable plugins, lift restrictions, or substitute a Pi
CLI. Provider capability/fresh-context/depth checks remain in force.

This does not configure unrelated DSH delegation tools or remote providers.
Custom profiles and provider versions need their own runtime verification.

### Contract evidence and test boundaries

The DSH contract was inspected at `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- [spawn provider](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent-spawn-in-process/src/index.ts)
- [child composition](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent/src/child-agent.ts)
- [tool registry](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts)

`test:parallel` tests real adapter registration with controlled host doubles:
missing/disabled tools, scoped restrictions, child cleanup, and tool-free
summarizers. `test:adapters` covers Pi settings migration/diagnosis, while
`test:upgrade` verifies child references survive successive package relocations.
These hermetic tests are not DSH authenticated-host end-to-end tests.
