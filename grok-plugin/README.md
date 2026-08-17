# search-boost Grok Plugin

Install MCP + skill into Grok Build:

```bash
grok plugin install ./grok-plugin --trust
search-boost install -t grok -y --auto-allow   # optional routing rule (model decides when to search)
```

Verify:

```bash
grok inspect
grok mcp doctor search-boost
```

Regenerate skill from source (after editing `agents/grok/skill.md`):

```bash
npm run plugin:sync-grok
```

Marketplace: submit a PR to [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace) with a remote source pinned to a commit SHA.
