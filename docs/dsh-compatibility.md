# DSH compatibility checks

SearchBoost registers native DSH tools through `adapters/dsh/`. The tested DSH
schema contract is `@deepseek-ai/dsh-tools@0.1.5-rc.3` (a pinned development
dependency, not a bundled second host runtime).

## `unsupported JSON schema` on startup

DSH's schema subset rejects type arrays, schema-valued `additionalProperties`,
and numeric/string/array bounds. In particular, nullable dates/cursors and
engine-weight dictionaries prevented `fused_search` and `adaptive_search` from
registering. A permissive mock registry did not catch this.

`adapters/dsh/schema.js` projects the shared schemas into DSH's supported subset:
nullable scalars become `oneOf`, dictionary values are checked at execution, and
bounds are retained in descriptions. A top-level `oneOf` of disjoint object
branches (the shared v5 ∪ historical `adaptive_search` response union) also
translates, and disjoint nonempty array unions become `oneOf`.
Arbitrary overlapping `anyOf` unions are rejected rather than silently changed.
Ajv validates the original input and output contracts without coercion, defaults,
or property removal. MCP/Pi schemas are
unchanged. All six DSH tools are checked against the actual host registry and
its TypeScript/Python schema compilers. Schema translation retains the shared
entry switches: DSH registers all six tools, but disabled calls and calls to
`adaptive_search` without Jev credentials are rejected before core execution.

## npm and npx installation

```sh
# Global SearchBoost installation
npm install -g search-boost@latest
search-boost install -t dsh --profile web -y

# Or run without global SearchBoost/DSH/pnpm installations
npx --yes search-boost@latest install -t dsh --profile web -y
```

The installer prefers available global `dsh`/`pnpm` launchers. Missing launchers
are supplied through `npm exec` (the npx equivalent), using the npm cache rather
than modifying global installations. First use requires registry access.
Published SearchBoost installs pin the profile dependency to the running CLI's
version; no `_npx` path is saved in the DSH profile. Successful exit alone is not
accepted: the profile bundle registration, installed version, and adapter files
must also be present. Restart DSH after installing/updating the plugin.

An unpublished checkout uses its local package path instead of downloading a
released version. DSH 0.1.5-rc.3 itself forwards pnpm arguments through a shell on
Windows; source-checkout paths containing spaces are not covered by the
published npm/npx registry-spec guarantee. Use a space-free checkout path for
that upstream source-install path.

## Validation

For actual Windows/Linux host boots and live search/fetch results, see
[the 2026-09-27 live verification record](dsh-live-verification.md), including
upstream failures encountered when mixing DSH versions in one home.

- `npm run test:adapters`: real DSH registration and schema/SDK validation, plus
  host adapter behavior. Includes nullable values, maps, input limits, stats
  output fields, both Jev keyword shapes, v3 results, credential locks, live tool
  switches, and preservation of shared schemas.
- `npm run test:dsh-install`: isolated launcher tests (native `.cmd` on Windows),
  npm-exec fallback, paths/profiles with spaces, failure propagation, no-op
  launcher rejection, installed-version verification, and dry-run behavior.
- `npm run test:dsh-package`: real `npm pack`, global npm install and npm-exec/npx
  install of that tarball in isolated directories with spaces. Imports the
  installed adapter into the actual DSH registry and checks durable versioned
  profile specs. Uses npm registry access for dependencies.

CI runs these checks on Linux, Windows, and macOS. Launcher tests use controlled
DSH/pnpm fixtures; packaging tests use the actual DSH tool runtime, not a full
browser session or live LLM request. A CI matrix is not evidence that unrun
platform jobs passed, and local changes do not update the npm release.
