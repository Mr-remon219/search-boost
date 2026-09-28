/** Terminate subprocesses created in our own process group, never the host's group.
 * Windows has no POSIX groups: taskkill /T is the supported tree operation.
 * Callers still need an independent completion deadline if stdio never closes.
 */
import { spawn } from 'node:child_process'
import { parse } from 'node:path'

export function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      // This short-lived, unref'ed helper may outlive the command. Windows
      // locks a process's cwd, so do not let it pin a caller's disposable tree.
      cwd: parse(process.execPath).root,
      windowsHide: true, stdio: 'ignore', shell: false,
    })
    const timer = setTimeout(() => { try { killer.kill() } catch {} }, 2000)
    timer.unref?.()
    killer.once('error', () => { clearTimeout(timer); try { child.kill(signal) } catch {} })
    killer.once('close', () => clearTimeout(timer))
    killer.unref()
    return
  }
  try { process.kill(-child.pid, signal) } catch {
    // A failed spawn has no process group; never signal our own group instead.
    try { child.kill(signal) } catch { /* already gone */ }
  }
}
