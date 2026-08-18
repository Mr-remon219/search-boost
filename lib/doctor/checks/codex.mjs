import { existsSync, readFileSync } from 'node:fs'
import { webSearchInsideMcpSection } from '../../codex-toml.mjs'
import { codexNativeReplaced } from '../../native-search.mjs'
import { agentConfigured, PATHS } from '../../paths.mjs'
import { hasTomlSection } from '../../toml.mjs'

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
  const misplaced = webSearchInsideMcpSection(toml)
  const mcpConfigured = hasTomlSection(toml, 'search-boost')
  const topLevelDisabled = codexNativeReplaced(toml)

  if (misplaced) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'fail',
      message: 'web_search or SEARCH_BOOST marker inside [mcp_servers.search-boost] (Codex ignores it)',
      fix_hint: 'search-boost install -t codex -y --replace-native',
      details: { file, misplaced: true, topLevelDisabled },
    }
  }

  if (mcpConfigured && !topLevelDisabled && /(?:^|\n)\s*web_search\s*=/m.test(toml)) {
    return {
      id: 'codex_web_search_config',
      category: 'agents',
      status: 'warn',
      message: 'Codex web_search is not disabled at top level while search-boost MCP is configured',
      fix_hint: 'search-boost install -t codex -y --replace-native',
      details: { file, mcpConfigured, topLevelDisabled },
    }
  }

  return {
    id: 'codex_web_search_config',
    category: 'agents',
    status: 'pass',
    message: 'Codex web_search placement OK',
    details: { file, mcpConfigured, topLevelDisabled },
  }
}
