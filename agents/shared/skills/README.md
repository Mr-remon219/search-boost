# Optional workflow extensions

The installed `search-boost` router is permanent. Ordinary MCP calls use tool descriptions and schemas directly; do not create one skill per tool or duplicate parameter documentation here.

The bundled `search-boost-parallel-research` workflow reuses the Pi/DSH research roles through each MCP host's actual subagent capabilities, with an explicit serial fallback when unavailable. Shared roles/workflow live in `agents/shared/research/`; host execution notes live at `agents/<host>/parallel.md`. Cursor CLI uses Cursor's notes because the two share an installed skill directory.

## Adding a workflow

1. Create `agents/shared/skills/search-boost-<workflow>/SKILL.md` with `name`, a task-specific `description`, and `<!-- search-boost: skill -->`. The frontmatter name must match the directory name. A specialist must have its own frontmatter; keep detailed reference material out of the router.
2. Register it in `SKILL_EXTENSIONS` in `agents/router.mjs`:

   ```js
   {
     name: 'search-boost-<workflow>',
     description: 'When this workflow should be selected.',
     path: join(AGENTS_ROOT, 'shared', 'skills', 'search-boost-<workflow>', 'SKILL.md'),
     agents: ['claude'], // Optional: omit only if supported by all MCP hosts.
   }
   ```

   Replace `<workflow>` with a concrete lowercase hyphenated name. Names must start with `search-boost-`; retired tool-manual names are reserved for migration.
3. The registry drives installation, uninstallation, plugin bundles, and the router's `{{EXTENSION_ROUTES}}` links. Do not maintain a separate handwritten route list. Host runtimes (pi/DSH) do not install these MCP skills.
4. Optional template tokens: `{{RESEARCH_WORKFLOW}}`, `{{RESEARCH_SEARCHER}}`, `{{RESEARCH_SUMMARIZER}}`, `{{PARALLEL_HOST}}` (requires host notes), `{{MCP_CONTEXT}}`, `{{TOOL_FUSED_SEARCH}}`, `{{TOOL_FETCH_PAGE}}`, `{{TOOL_X_SEARCH}}`, `{{TOOL_SEARCH_LAYER}}`, and `{{TOOL_SEARCH_STATS}}`. They resolve to the supported host's calling conventions. Use the host's actual registered tool names if they differ. Codex gets dependency metadata alongside each registered skill.
5. Run `npm run test:skills`, sync affected plugins (`npm run plugin:sync-grok` / `npm run build:plugin`), and reinstall the target host.

A delegation skill must check the host's real subagent tools, permissions, and failure behavior. Skill text does not create tools or authorize delegation. List only implemented workflows; the router must not advertise hypothetical capabilities. A universally installed workflow must have an honest capability check and serial/blocked path for hosts without native delegation.

The current extension installer copies `SKILL.md` and generated Codex metadata only. If a workflow needs scripts or supporting files, extend the asset manifest, ownership-safe installation, and tests before referencing them. When retiring a shipped workflow, add its name to the explicit retirement list so upgrades can clean up owned files without deleting user additions.
