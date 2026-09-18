#!/usr/bin/env node
/**
 * search-boost MCP server (stdio) — thin entry; the MCP host adapter lives in
 * adapters/mcp/ and runs on SearchBoost Core (lib/runtime.mjs).
 */
import { serveStdio } from './adapters/mcp/server.mjs'

await serveStdio()
