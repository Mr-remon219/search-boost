import { spawnSync } from 'node:child_process'

// A config directory can be empty, stale, or created by SearchBoost itself.
// Detection must not mistake it for an installed CLI. Version probes neither
// start a session nor install anything; raw host output is never exposed.
const CACHE_MS = 30_000
let codexCache
export function codexCliDetected({ env = process.env, platform = process.platform, run = spawnSync, now = Date.now() } = {}) {
  const path = Object.entries(env).filter(([key]) => /^(path|pathext|comspec)$/i.test(key)).sort().map(([key, value]) => `${key}=${value}`).join('\n')
  const cached = run === spawnSync
  if (cached && codexCache?.path === path && codexCache.platform === platform && now - codexCache.at < CACHE_MS) return codexCache.detected
  let detected = false
  try {
    const windows = platform === 'win32'
    const result = run(windows ? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe' : 'codex',
      windows ? ['/d', '/s', '/c', 'codex --version'] : ['--version'],
      { env, encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] })
    detected = !result.error && result.status === 0 && /^codex(?:-cli)?\s+\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/m.test(String(result.stdout ?? '').trim())
  } catch { /* missing, broken, untrusted output or timed-out launcher is not detected */ }
  if (cached) codexCache = { path, platform, at: now, detected }
  return detected
}
