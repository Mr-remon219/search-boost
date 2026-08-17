import { execSync } from 'node:child_process'

/**
 * Resolve system Node, excluding IDE-bundled node.exe from cursor-agent.
 * Shared by MCP launch and Cursor sessionStart hooks.
 */
export function resolveSystemNode() {
  let node = process.execPath.replace(/\\/g, '/')
  try {
    const found = execSync(process.platform === 'win32' ? 'where node' : 'which node', {
      encoding: 'utf8',
      windowsHide: true,
    }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const pick = found.find((p) => !/cursor-agent|Cursor/i.test(p)) ?? found[0]
    if (pick) node = pick.replace(/\\/g, '/')
  } catch { /* use execPath */ }
  return node
}
