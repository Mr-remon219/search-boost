import { AGENT_IDS, agentStatus } from '../../agents/index.mjs'
import { agentConfigured } from '../../paths.mjs'
import { nativeSearchStatus, replaceableNativeIds } from '../../native-search.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkAgentInstallCoverage(_ctx) {
  const detected = AGENT_IDS.filter((id) => agentStatus(id).detected)
  const configured = AGENT_IDS.filter((id) => agentConfigured(id))
  const detectedConfigured = detected.filter((id) => agentConfigured(id))

  if (detectedConfigured.length > 0) {
    return {
      id: 'agent_install_coverage',
      category: 'agents',
      status: 'pass',
      message: `${detectedConfigured.length} detected agent(s) configured (${detectedConfigured.join(', ')})`,
      details: { configured: detectedConfigured, detected },
    }
  }

  if (detected.length > 0) {
    return {
      id: 'agent_install_coverage',
      category: 'agents',
      status: 'warn',
      message: `${detected.length} agent(s) detected but none configured`,
      fix_hint: 'search-boost install -y',
      details: { detected, configured },
    }
  }

  if (configured.length > 0) {
    return {
      id: 'agent_install_coverage',
      category: 'agents',
      status: 'pass',
      message: `${configured.length} agent(s) configured (${configured.join(', ')})`,
      details: { configured, detected },
    }
  }

  return {
    id: 'agent_install_coverage',
    category: 'agents',
    status: 'warn',
    message: 'No agents detected or configured',
    fix_hint: 'search-boost install -y or search-boost install -t cursor -y',
    details: { detected, configured },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkAgentDetectedUnconfigured(_ctx) {
  /** @type {string[]} */
  const gaps = []
  for (const id of AGENT_IDS) {
    const s = agentStatus(id)
    if (s.detected && !agentConfigured(id)) gaps.push(id)
  }

  if (gaps.length) {
    return {
      id: 'agent_detected_unconfigured',
      category: 'agents',
      status: 'warn',
      message: `Detected but not configured: ${gaps.join(', ')}`,
      fix_hint: `search-boost install -t ${gaps.join(',')} -y --auto-allow`,
      details: { agents: gaps },
    }
  }

  return {
    id: 'agent_detected_unconfigured',
    category: 'agents',
    status: 'pass',
    message: 'All detected agents configured',
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkNativeSearchMismatch(_ctx) {
  /** @type {Array<{ id: string, state: string, name: string }>} */
  const mismatches = []
  for (const id of replaceableNativeIds()) {
    const s = agentStatus(id)
    if (!s.detected || !agentConfigured(id)) continue
    const native = nativeSearchStatus(id)
    if (native.state !== 'replaced') {
      mismatches.push({ id, state: native.state, name: native.name })
    }
  }

  if (mismatches.length) {
    return {
      id: 'native_search_mismatch',
      category: 'agents',
      status: 'warn',
      message: mismatches.map((m) => `${m.id} (${m.name} still ${m.state})`).join('; '),
      fix_hint: 'search-boost config search --replace-native -t codex,claude',
      details: { mismatches },
    }
  }

  return {
    id: 'native_search_mismatch',
    category: 'agents',
    status: 'pass',
    message: 'Native search policy consistent (or N/A)',
  }
}
