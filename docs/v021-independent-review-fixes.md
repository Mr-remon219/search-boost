# v0.2.1 independent-review fixes (R1–R4)

- **R1 — upgrade isolation:** MCP scheduling uses the same complete managed-file
  set as transaction backup/rollback, including skills, retired skills, hooks and
  instruction files. Intersecting sets (including transitive intersections and
  directory aliases) run serially. Runtime/package receipts, project receipts
  and Grok plugin work also retain shared-resource serialization. Unrelated
  components remain concurrent; results retain discovery order. Asset-resolution
  errors block only the affected target, without preventing unrelated upgrades.
- **R2 — Codex preferences:** upgrade leaves root-level managed settings and
  restoration records unchanged. Only legacy, misplaced `disabled` blocks
  without restoration records are migrated. An existing root preference wins;
  explicit install/config actions may still replace native search as requested.
  The v0.2.0/master implementation (`9c3d91f`, `applyCodexNativeToml` →
  `injectTomlSection`) emitted no restoration record. A misplaced block with a
  record, even `{ "assignment": null }`, is therefore not treated as known legacy
  output: upgrade preserves it for manual correction rather than inferring a new
  root preference or losing the recorded value.
- **R3 — host dotfiles:** JSON/text host writers follow existing symlinks to
  regular files, atomically update the resolved target and preserve the links.
  Relative/chained links are supported. Dangling/cyclic links and non-file
  targets fail without replacing the link. Credential writers still reject
  symlinks. **Existing limitations remain:** `upgrade --sync-only` does not
  support symlinked files in its backup set. During uninstall, paths whose
  content becomes empty may have the symlink itself removed while the target
  retains its old contents. This fix restores installation compatibility only;
  it does not promise a link-preserving install/upgrade/uninstall round trip.
- **R4 — manual Codex configuration:** `print codex` emits the root search
  setting before the MCP table, with instructions to place it before every
  table and avoid duplicate root assignments.

## Regression checks

```sh
node scripts/test-review-regressions.mjs
npm run test:v021
npm run prepublishOnly
```

The review regression suite requires **Python 3.11+** (`python3` or `python`)
for independent TOML parsing with the standard-library `tomllib`. This is a
source-test dependency only, not a package runtime requirement. Ubuntu/Windows
CI explicitly installs Python 3.12 and runs this suite via `test:v021`.

Tests use isolated homes and real CLI/upgrade entry points. The R1 test injects
an I/O failure after another target succeeds and checks that all its shared
assets survive rollback. This is fault injection, not a report of a production
EACCES occurrence. Windows file-symlink tests explicitly report skips if the
runner lacks symlink privileges; Linux exercises them without that restriction.
