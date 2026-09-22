import {
  checkAgentDetectedUnconfigured,
  checkAgentInstallCoverage,
  checkNativeSearchMismatch,
} from './checks/agents.mjs'
import {
  checkAntigravityMcpDuplication,
  checkAntigravityPermissionConfig,
} from './checks/antigravity.mjs'
import { checkClaudeOrphanDeny, checkClaudePartialInstall, checkClaudePermissionConfig } from './checks/claude.mjs'
import { checkCodexWebSearchConfig } from './checks/codex.mjs'
import { checkCursorHookConfig } from './checks/cursor.mjs'
import { checkGrokPermissionConfig } from './checks/grok.mjs'
import {
  checkConfigLayout,
  checkConfigPathsWritable,
  checkEnvKeyDivergence,
  checkKeysFileIntegrity,
  checkLayerConfigValid,
  checkLayerKeysCoherence,
} from './checks/config.mjs'
import {
  checkApiKeyedPool,
  checkFreeEnginePool,
  checkXSearchMode,
} from './checks/engines.mjs'
import {
  checkMcpLaunchCommand,
  checkMcpNodeNotIdeBundled,
} from './checks/mcp.mjs'
import { checkNodeVersion } from './checks/runtime.mjs'
import { checkPiSubagentTools } from './checks/pi.mjs'

/** @typedef {import('./types.mjs').DoctorCheck} DoctorCheck */

/** @returns {DoctorCheck[]} */
export function buildChecks() {
  return [
    { id: 'node_version', category: 'runtime', title: 'Node.js version', run: checkNodeVersion },
    { id: 'layer_config_valid', category: 'config', title: 'Layer config readable', run: checkLayerConfigValid },
    { id: 'layer_keys_coherence', category: 'config', title: 'Layer matches keys', run: checkLayerKeysCoherence },
    { id: 'keys_file_integrity', category: 'config', title: 'Keys file parseable', run: checkKeysFileIntegrity },
    { id: 'env_key_divergence', category: 'config', title: 'Env vs file keys', run: checkEnvKeyDivergence },
    { id: 'config_layout', category: 'config', title: 'Config directory layout', run: checkConfigLayout },
    { id: 'config_paths_writable', category: 'config', title: 'Config write paths OK', run: checkConfigPathsWritable },
    { id: 'agent_install_coverage', category: 'agents', title: 'At least one agent wired', run: checkAgentInstallCoverage },
    { id: 'agent_detected_unconfigured', category: 'agents', title: 'Per-agent gaps', run: checkAgentDetectedUnconfigured },
    { id: 'native_search_mismatch', category: 'agents', title: 'Native search policy', run: checkNativeSearchMismatch },
    { id: 'pi_subagent_tools', category: 'agents', title: 'Pi child search tools', run: checkPiSubagentTools },
    { id: 'claude_orphan_deny', category: 'agents', title: 'Claude orphan WebSearch deny', run: checkClaudeOrphanDeny },
    { id: 'claude_partial_install', category: 'agents', title: 'Claude partial install', run: checkClaudePartialInstall },
    { id: 'claude_permission_config', category: 'agents', title: 'Claude permission config', run: checkClaudePermissionConfig },
    { id: 'codex_web_search_config', category: 'agents', title: 'Codex web_search placement', run: checkCodexWebSearchConfig },
    { id: 'grok_permission_config', category: 'agents', title: 'Grok permission blocks', run: checkGrokPermissionConfig },
    { id: 'cursor_hook_config', category: 'agents', title: 'Cursor hook config', run: checkCursorHookConfig },
    { id: 'antigravity_mcp_duplication', category: 'agents', title: 'Antigravity MCP duplication', run: checkAntigravityMcpDuplication },
    { id: 'antigravity_permission_config', category: 'agents', title: 'Antigravity permissions', run: checkAntigravityPermissionConfig },
    { id: 'free_engine_pool', category: 'engines', title: 'Free-tier engines', run: checkFreeEnginePool },
    { id: 'api_keyed_pool', category: 'engines', title: 'API keyed engines', run: checkApiKeyedPool },
    { id: 'x_search_mode', category: 'engines', title: 'X search path', run: checkXSearchMode },
    { id: 'mcp_launch_command', category: 'mcp', title: 'MCP launch resolvable', run: checkMcpLaunchCommand },
    { id: 'mcp_node_not_ide_bundled', category: 'mcp', title: 'System Node for GUI agents', run: checkMcpNodeNotIdeBundled },
  ]
}

/** Stable registry ids for drift tests. */
export const CHECK_IDS = buildChecks().map((c) => c.id)
