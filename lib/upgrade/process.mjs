/** Bounded package-manager/host commands. Output may contain secrets: never echo it on failure. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { terminateProcessTree } from '../process-tree.mjs'

/**
 * npm's JS entry, so npm can be driven by the current node instead of a shim.
 * On Windows `where npm` lists the extensionless Git Bash script first; invoked
 * by bare name its `dirname "$0"` collapses to ".", so
 * node_modules/npm/bin/npm-cli.js resolves against the *current directory* and
 * fails. Reading PATH here also skips cmd.exe's current-directory-first search.
 */
export function npmCliEntry(env) {
  const fromEnv = env.npm_execpath
  if (typeof fromEnv === 'string' && fromEnv && existsSync(fromEnv)) return fromEnv
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    const cli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(cli)) return cli
  }
  return null
}

export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 180_000, signal, killGraceMs = 3000, closeGraceMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    let shell = false
    if (process.platform === 'win32' && command === 'npm') {
      const cli = npmCliEntry(env)
      if (cli) { command = process.execPath; args = [cli, ...args] }
    }
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
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reject(new Error('Invalid command timeout'))
    if (signal?.aborted) return resolve({ code: 130, stdout: '', stderr: '' })
    const child = spawn(command, args, {
      cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', outcome = null, settled = false
    let forceTimer, finalTimer, exitTimer
    const clear = () => {
      for (const handle of [timer, forceTimer, finalTimer, exitTimer]) clearTimeout(handle)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (code) => {
      if (settled) return
      settled = true
      clear()
      // close is not guaranteed when a grandchild inherits the output pipes.
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
      resolve({ code: outcome ?? code ?? 1, stdout, stderr })
    }
    const stop = (code) => {
      if (settled || outcome !== null) return
      outcome = code
      terminateProcessTree(child, 'SIGTERM')
      forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), killGraceMs)
      finalTimer = setTimeout(() => finish(code), killGraceMs + closeGraceMs)
    }
    const onAbort = () => stop(130)
    const timer = setTimeout(() => stop(124), timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-2_000_000) })
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-20_000) })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clear()
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
      reject(new Error(`Cannot start ${shell ? 'host command' : command}: ${err.code ?? 'spawn failure'}`))
    })
    child.once('exit', () => {
      // A reparented child retaining pipes must not stall until the full command
      // deadline. Leave a short drain window, then fail and reclaim its group.
      if (!settled && outcome === null) exitTimer = setTimeout(() => stop(125), closeGraceMs)
    })
    child.once('close', (code) => {
      if (outcome !== null) terminateProcessTree(child, 'SIGKILL')
      finish(code)
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
