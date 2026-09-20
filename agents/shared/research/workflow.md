## Shared workflow

Use direct search for one lookup. Use this workflow only for independent research angles and only when delegation is authorized by the user and host policy. Loading this text is not authorization to spawn agents, enable features, or change permissions.

1. Define the question, scope, relevant version/date, sufficient evidence, and budget. Split only genuinely independent angles; usually 2–4 searchers suffice, within the host's concurrency limits. Keep research read-only.
2. Give each searcher the question context, one bounded task, the shared searcher instructions (injected by the native runner, or copied below from the skill), the actual search/read tool names, and a stopping condition. Do not assume a child sees this skill or the parent's tools/context.
3. Start one wave through the host's real delegation mechanism; preserve run IDs and track completion, failure, timeout, and cancellation separately. Wait through the host's supported notification/wait mechanism, not repeated polling. Cancel remaining children on user cancellation and release owned child resources when supported.
4. Fast mode: one wave, then the parent synthesizes and stops. Complex mode: pass all reports and their statuses to a no-search summarizer (or do that reasoning in the parent). Default 1–2 waves, at most 3. Launch only material new gap tasks, within the original budget; stop earlier when evidence is sufficient.
5. The parent checks important claims against supplied evidence, resolves conflicting versions/dates, and produces the final cited answer. A URL list or domain count is not proof of corroboration. Keep single-source claims and remaining uncertainty explicit. Disclose failed tasks, partial/truncated reports, and any serial fallback.

Before fan-out, verify child access to the search/read tools through the host's supported discovery/permission mechanism. If inheritance is uncertain, use the first real bounded research task as a capability check before launching the remainder. Never spend an extra wave just to manufacture proof of capability.

If delegation or child MCP access is absent, explain the limitation and perform labeled serial research in the parent only if browsing is allowed and parallelism was not a strict user requirement. If tools are denied, a runtime fails, or cancellation is requested, stop that path and report the blocker; do not silently switch to a CLI, install another runtime, or bypass controls. A skill cannot enforce tool isolation, hard timeouts, or cancellation where the host does not expose them.
