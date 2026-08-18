import { resolveMcpLaunch } from '../../mcp-entry.mjs'
import { resolveSystemNode } from '../../system-node.mjs'

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkMcpLaunchCommand(_ctx) {
  const launch = resolveMcpLaunch()
  const cmd = launch.command
  if (cmd === 'npx') {
    return {
      id: 'mcp_launch_command',
      category: 'mcp',
      status: 'warn',
      message: 'Fallback launch via npx -y search-boost-mcp (slower)',
      fix_hint: 'npm i -g search-boost-mcp',
      details: { command: cmd, args: launch.args },
    }
  }
  return {
    id: 'mcp_launch_command',
    category: 'mcp',
    status: 'pass',
    message: `${cmd} ${(launch.args ?? []).join(' ')}`.trim(),
    details: { command: cmd, args: launch.args },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkMcpNodeNotIdeBundled(_ctx) {
  const node = resolveSystemNode()
  if (/cursor-agent|Cursor/i.test(node)) {
    return {
      id: 'mcp_node_not_ide_bundled',
      category: 'mcp',
      status: 'warn',
      message: 'Only IDE-bundled Node found',
      fix_hint: 'Install system Node >=22.13; fix PATH',
      details: { node },
    }
  }
  return {
    id: 'mcp_node_not_ide_bundled',
    category: 'mcp',
    status: 'pass',
    message: node,
    details: { node },
  }
}
