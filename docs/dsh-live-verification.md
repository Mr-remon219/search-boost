# DSH live verification — 2026-09-27

## Artifact and scope

This run installed the **local repaired tarball**, not the published npm release:

- Package: `search-boost-0.2.2.tgz` (unpublished working-tree repair).
- Integrity: `sha512-z3Y3+cSOjlS+eyk/G19/PocjLgtMgjqFKIL7/z74IQ1zKytS1iV/WvRs1UraUx4dHGzjVNljUoY+3JCczBVwgA==`.
- Installation used real `dsh plugin --profile … add <tarball>` / pnpm.
- Each test booted the actual DSH web application on loopback with an ephemeral
  port. A temporary Cordis probe waited for the loader, inspected the six tools,
  called `search_stats`, ran `fused_search` against Bing/DDG with query
  `DeepSeek Harness GitHub`, and fetched `https://example.com`.
- The modern host's page was checked using its normal launch-token/cookie
  exchange. Tokens and credential values are not included in these reports.
- These are live host/tool/network checks, not simulated registrations. They
  do **not** establish model-driven chat behavior or account billing/auth status.

## Passing runs

| Platform / entry | DSH | Node | Result |
| --- | --- | --- | --- |
| Linux, existing npm-local CLI | 0.1.5-rc.3 | 24.20.0 | Exit 0 |
| Windows, existing npx installation, invoked from PowerShell | 0.1.0-rc.6 | 22.23.1 | Exit 0 |
| Windows, actual npm global-prefix installation, `dsh.cmd` | 0.1.5-rc.3 | 22.23.1 | Exit 0, separate DSH_HOME |
| Windows PowerShell, npm-generated `dsh.ps1` | 0.1.5-rc.3 | 22.23.1 | Exit 0, separate DSH_HOME |

Every passing run had:

- All six SearchBoost tools registered and exposed in native tool schemas.
- No `registration failed`, `unsupported JSON schema`, or nullable
  `published.type` registration failure.
- HTTP 200 with the actual web application's HTML.
- Successful real `fused_search` output with three results.
- Successful `fetch_page`, returning example.com content (22 words).

Windows retained its pre-existing `api` search-layer setting. Explicit Bing/DDG
selection produced an informational free-engine-only warning; no provider keys
or persistent search defaults were changed to suppress it.

## Additional upstream failures found (not hidden by the passing runs)

Switching the old npx host and new npm host against the **same** existing Windows
`DSH_HOME` is not safe in this tested combination:

1. DSH can fail with `EBUSY` while replacing junctions under
   `.dsh/profiles/node_modules`. The failure precedes SearchBoost loading.
2. The modern host migrates `.credentials.yaml` from a flat key map to the
   versioned `refs`/`records` layout. The old host then rejects `version` because
   it expects every top-level value to be a string.

These are DSH host-version coexistence issues, not the repaired plugin's schema
error. This work does not claim to fix the upstream host implementations.

Recovery performed on the test machine:

- Retained backups of generated fallback generations.
- Used the old host's own fallback resolver to build and check an idempotent
  generation in a staging directory, then installed that generation.
- Backed up the modern credential document and restored the old flat layout,
  verifying that both existing credential values were preserved exactly.
- Rebooted the original npx host successfully and repeated all live checks.
- Kept the modern npm installation in a separate, invocation-scoped DSH_HOME;
  did not change the user's PATH, execution policy, or default web profile.

## Retained local evidence

Under `~/.dsh/artifacts/search-boost-fix-20260927/` on the corresponding system:

- `linux-npm-report.json`
- `windows-npx-final-report.json`
- `windows-npm-cmd-report.json`
- `windows-npm-powershell-isolated-report.json`
- The tested tarball and probe source.
- Windows `start-fixed-npx.ps1` and `start-fixed-npm.ps1`, which preserve the
  tested host/profile pairing. The npm launcher uses its separate model settings
  and credentials; it does not copy credentials from the original home.

The test-only probe patch was removed after verification so launching the
retained profiles no longer executes test searches or automatically exits.
Existing default web profile registrations were left unchanged. The repaired
plugin is installed in dedicated verification profiles, not silently promoted
to every existing profile.

## Remaining limits

- macOS real-host execution has not been performed; the repository CI matrix
  includes macOS, but an unrun job is not a passing result.
- No npm release was published. `npx search-boost@latest` may still obtain the
  old release until the repair is released.
