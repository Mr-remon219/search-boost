/** Bounded package-manager/host commands. Output may contain secrets: never echo it on failure. */
import { spawn } from 'node:child_process'

export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    let shell = false
    // npm/host launchers can be .cmd on Windows. Reject shell metacharacters rather
    // than interpolating user-controlled paths into cmd.exe. Spaces remain valid.
    if (process.platform === 'win32' && ['npm', 'dsh', 'grok'].includes(command)) {
      if ([command, ...args].some((s) => /["%!^&|<>\r\n]/.test(s))) {
        reject(new Error('Unsupported Windows command path characters; use a path without shell metacharacters.'))
        return
      }
      command = [command, ...args].map((s) => `"${s}"`).join(' ')
      args = []
      shell = true
    }
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 3000)
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-2_000_000) })
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-20_000) })
    child.once('error', (err) => {
      clearTimeout(timer); clearTimeout(forceTimer)
      reject(new Error(`Cannot start ${shell ? 'host command' : command}: ${err.code ?? 'spawn failure'}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer); clearTimeout(forceTimer)
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr })
    })
  })
}

export async function checkedCommand(run, command, args, options) {
  const result = await run(command, args, options)
  if (result.code !== 0) throw new Error(`${command} ${args[0] ?? ''} failed (exit ${result.code}); no successful upgrade is assumed. Check the host/package-manager diagnostics locally.`)
  return result.stdout
}

/** Strict SemVer comparison (including prerelease); no lexical 1.10 < 1.9 mistake. */
export function compareVersions(a, b) {
  function parse(value) {
    const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
    if (!m || m[4]?.split('.').some((s) => /^0\d+$/.test(s))) throw new Error('Invalid package version returned; refusing upgrade')
    return { n: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1
  if (!x.pre || !y.pre) return !x.pre && !y.pre ? 0 : x.pre ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === q) continue
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1
    if (pn !== qn) return pn ? -1 : 1
    return p > q ? 1 : -1
  }
  return 0
}
