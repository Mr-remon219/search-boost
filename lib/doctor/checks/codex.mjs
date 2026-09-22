import { existsSync, readFileSync } from 'node:fs'
import { findMisplacedCodexWebSearch } from '../../codex-toml.mjs'
import { agentConfigured, PATHS } from '../../paths.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkCodexWebSearchConfig(_ctx) {
  if (!agentConfigured('codex')) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'pass',
      message: 'Codex not configured (N/A)',
    }
  }

  const file = PATHS.codex.config
  if (!existsSync(file)) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'pass',
      message: 'Codex config missing (N/A)',
    }
  }

  const toml = readFileSync(file, 'utf8')
  const misplaced = findMisplacedCodexWebSearch(toml)

  if (misplaced?.marker) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'fail',
      message: 'Legacy SEARCH_BOOST web_search block inside [mcp_servers.search-boost] (Codex ignores it)',
      fix_hint: 'search-boost install -t codex -y  (cleans the misplaced block)',
      details: { file, misplaced },
    }
  }

  if (misplaced?.bare) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'warn',
      message: 'web_search inside [mcp_servers.search-boost] has no effect (Codex reads only the top-level key)',
      fix_hint: 'Move web_search to the top level of config.toml or remove it',
      details: { file, misplaced },
    }
  }

  return {
    id: 'codex_web_search_config',
    category: 'agents',
    status: 'pass',
    message: 'Codex web_search placement OK',
    details: { file },
  }
}
