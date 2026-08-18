import { existsSync, readFileSync } from 'node:fs'
import { agentConfigured, grokConfigCandidates } from '../../paths.mjs'
import {
  countPermissionSections,
  grokAlwaysApproveMode,
  grokPermissionBlockRedundant,
  hasLegacySearchBoostPermission,
} from '../../grok-toml.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkGrokPermissionConfig(_ctx) {
  if (!agentConfigured('grok')) {
    return {
      id: 'grok_permission_config',
      category: 'agents',
      status: 'pass',
      message: 'Grok not configured (N/A)',
    }
  }

  /** @type {Array<{ file: string, sections: number, alwaysApprove: boolean, legacy: boolean, redundant: boolean }>} */
  const findings = []
  for (const file of grokConfigCandidates()) {
    if (!existsSync(file)) continue
    const toml = readFileSync(file, 'utf8')
    findings.push({
      file,
      sections: countPermissionSections(toml),
      alwaysApprove: grokAlwaysApproveMode(toml),
      legacy: hasLegacySearchBoostPermission(toml),
      redundant: grokPermissionBlockRedundant(toml),
    })
  }

  const dupes = findings.filter((f) => f.sections > 1)
  if (dupes.length) {
    return {
      id: 'grok_permission_config',
      category: 'agents',
      status: 'fail',
      message: `Duplicate [permission] in Grok config (${dupes.map((f) => f.file).join(', ')}) — grok will not start`,
      fix_hint: 'search-boost install -t grok -y --auto-allow',
      details: { findings: dupes },
    }
  }

  const legacy = findings.filter((f) => f.legacy)
  if (legacy.length) {
    return {
      id: 'grok_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Unmarked search-boost [permission] block in Grok config (re-install to migrate)',
      fix_hint: 'search-boost install -t grok -y --auto-allow',
      details: { findings: legacy },
    }
  }

  const redundant = findings.filter((f) => f.redundant)
  if (redundant.length) {
    return {
      id: 'grok_permission_config',
      category: 'agents',
      status: 'warn',
      message: 'Grok permission_mode=always-approve makes search-boost [permission] redundant',
      fix_hint: 'search-boost install -t grok -y --auto-allow (cleans marked block) or remove [permission] manually',
      details: { findings: redundant },
    }
  }

  return {
    id: 'grok_permission_config',
    category: 'agents',
    status: 'pass',
    message: 'Grok permission config OK',
    details: { findings },
  }
}
