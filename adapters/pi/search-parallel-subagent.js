// pi host adapter — search-parallel-subagent via isolated pi child processes.
//
// The main agent decides who to spawn and how many. This file owns the host
// mechanism (agent-md load, process discovery, JSONL parsing, timeouts,
// transient retries). Searcher children load SearchBoost Core via -e this
// extension; summarizer children get --no-tools.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { piSubagentTemplatePaths } from '../../agents/router.mjs'
import { PATHS } from '../../lib/paths.mjs'
import { hostOf, normalizeUrl } from '../../lib/runtime.mjs'

/** Extension entry loaded into each searcher child. */
export const SEARCH_BOOST_EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')

export const SEARCHER_TOOLS = 'fused_search,fetch_page'
export const ALLOWED_AGENTS = new Set(['searcher', 'summarizer'])

function findPiCliScript() {
  const relative = path.join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
  const dirs = new Set([path.dirname(process.execPath)])
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) if (entry) dirs.add(entry)
  for (const dir of dirs) {
    const candidate = path.join(dir, relative)
    if (fs.existsSync(candidate)) return candidate
    if (fs.existsSync(path.join(dir, 'pi.cmd'))) {
      const besideLauncher = path.join(dir, relative)
      if (fs.existsSync(besideLauncher)) return besideLauncher
    }
  }
  return null
}

export function getPiInvocation(args) {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  const isPiCliScript = !!currentScript && /pi-coding-agent[\\/].*[\\/]cli\.js$/i.test(currentScript)
  if (currentScript && isPiCliScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }
  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) return { command: process.execPath, args }
  if (process.platform === 'win32') {
    const cli = findPiCliScript()
    if (cli) return { command: process.execPath, args: [cli, ...args] }
  }
  return { command: 'pi', args }
}

function parseToolList(value) {
  if (!value) return []
  return String(value).split(',').map((s) => s.trim()).filter(Boolean)
}

/** Parse YAML-frontmatter agent markdown (name / tools / model / body). */
export function parseAgentMarkdown(content, filePath = '') {
  const m = String(content ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  /** @type {Record<string, string>} */
  const fm = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (typeof fm.name !== 'string' || !fm.name) return null
  return {
    name: fm.name,
    description: fm.description ?? '',
    tools: parseToolList(fm.tools),
    model: fm.model || undefined,
    systemPrompt: m[2].trim(),
    filePath,
  }
}

/** Dest-first (`~/.pi/agent/agents/<name>.md`), then package template. */
export function resolveAgentPath(name) {
  const dest = path.join(PATHS.pi.agentsDir, `${name}.md`)
  if (fs.existsSync(dest)) return dest
  for (const src of piSubagentTemplatePaths()) {
    if (path.basename(src, '.md') === name) return src
  }
  return null
}

export function loadAgentConfig(name) {
  const filePath = resolveAgentPath(name)
  if (!filePath) return null
  try {
    return parseAgentMarkdown(fs.readFileSync(filePath, 'utf8'), filePath)
  } catch {
    return null
  }
}

/**
 * Child argv after `pi` / node+cli. searcher gets a tools whitelist;
 * summarizer must pass --no-tools (omitting --tools would give defaults).
 */
export function buildChildCliArgs(agent, task, promptFile, dispatch = {}) {
  const args = ['-ne', '--mode', 'json', '-p', '--no-session']
  if (agent.name === 'searcher') {
    args.push('-e', SEARCH_BOOST_EXT, '--tools', SEARCHER_TOOLS)
  } else {
    args.push('--no-tools')
  }
  const model = agent.model ?? dispatch.model
  if (model) args.push('--model', model)
  if (!agent.model && dispatch.thinkingLevel) args.push('--thinking', dispatch.thinkingLevel)
  if (promptFile) args.push('--append-system-prompt', promptFile)
  args.push(`Task: ${task}`)
  return args
}

export function normalizeTasks(params) {
  const hasSingle = Boolean(params?.agent && params?.task)
  const tasks = params?.tasks
  const hasTasks = Array.isArray(tasks)
  if (hasSingle === hasTasks) {
    throw new Error('search-parallel-subagent: provide exactly one of { agent, task } or tasks[]')
  }
  const items = hasSingle ? [{ agent: params.agent, task: params.task }] : tasks
  if (items.length === 0) {
    throw new Error('search-parallel-subagent: tasks must not be empty')
  }
  for (const item of items) {
    const agent = String(item?.agent ?? '').trim()
    const task = String(item?.task ?? '').trim()
    if (!agent || !task) {
      throw new Error('search-parallel-subagent: each item needs agent and task')
    }
    if (!ALLOWED_AGENTS.has(agent)) {
      throw new Error(`search-parallel-subagent: unknown agent "${agent}"`)
    }
  }
  return items.map((item) => ({ agent: String(item.agent).trim(), task: String(item.task).trim() }))
}

function appendBounded(current, chunk, maxChars = 12_000) {
  const combined = current + chunk
  return combined.length <= maxChars ? combined : combined.slice(-maxChars)
}

/** Parse actual cited HTTP(S) URLs from a subagent's final report. */
export function extractSourceUrls(text) {
  const urls = new Set()
  for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`\]}]+/g)) {
    let cleaned = match[0]
      .replace(/[.,;:!?]+$/, '')
      .replace(/(?:\*{1,3}|_{1,3}|~{1,2})$/, '')
    while (cleaned.endsWith(')') && (cleaned.match(/\)/g)?.length ?? 0) > (cleaned.match(/\(/g)?.length ?? 0)) {
      cleaned = cleaned.slice(0, -1)
    }
    const normalized = normalizeUrl(cleaned)
    if (normalized.startsWith('http') && hostOf(normalized)) urls.add(normalized)
  }
  return [...urls]
}

export function isTransientProviderTransportError(text) {
  return /websocket|socket hang up|econnreset|econnrefused|etimedout|epipe|connection (?:closed|limit|reset)|network error|fetch failed/i.test(text)
}

export function childAttemptSucceeded(state) {
  return !state.terminationRequested && !state.errorMessage && state.exitCode === 0
    && state.stopReason !== 'error' && state.stopReason !== 'aborted' && state.result.length > 0
}

function childEnvironment() {
  const env = { ...process.env }
  delete env.PI_SESSION_ID
  delete env.PI_SESSION_FILE
  delete env.PI_SUBAGENT_PARENT_SESSION
  return env
}

function writePromptToTempFile(agentName, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-'))
  const safe = agentName.replace(/[^\w.-]+/g, '_')
  const filePath = path.join(dir, `prompt-${safe}.md`)
  fs.writeFileSync(filePath, prompt, { encoding: 'utf8', mode: 0o600 })
  return { dir, filePath }
}

function abortedTask(item, started = Date.now(), error = 'aborted by caller') {
  return {
    agent: item.agent,
    task: item.task,
    ok: false,
    result: error,
    error,
    tookMs: Date.now() - started,
    turns: 0,
    attempts: 1,
    sources: [],
    domains: [],
  }
}

async function runAgentAttempt(item, timeoutMs, signal, dispatch) {
  const started = Date.now()
  if (signal?.aborted) return abortedTask(item, started)

  const agent = loadAgentConfig(item.agent)
  if (!agent || agent.name !== item.agent) {
    return abortedTask(item, started, `unknown or unreadable agent "${item.agent}"`)
  }

  let tmpDir = null
  let tmpPrompt = null
  try {
    if (agent.systemPrompt) {
      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt)
      tmpDir = tmp.dir
      tmpPrompt = tmp.filePath
    }
    const args = buildChildCliArgs(agent, item.task, tmpPrompt, dispatch)
    const invocation = getPiInvocation(args)
    if (signal?.aborted) return abortedTask(item, started)

    let turns = 0
    let stopReason = ''
    let errorMessage = ''
    let stderr = ''
    const messages = []
    let terminationRequested = false

    const exitCode = await new Promise((resolve) => {
      let settled = false
      let closed = false
      let forceTimer
      const finish = (code) => {
        if (settled) return
        settled = true
        resolve(code)
      }
      const proc = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment(),
      })
      let buffer = ''

      const forceStop = (reason) => {
        if (closed) return
        terminationRequested = true
        errorMessage ||= reason
        try { proc.kill('SIGTERM') } catch { /* already gone */ }
        forceTimer = setTimeout(() => {
          if (!closed) {
            try { proc.kill('SIGKILL') } catch { /* already gone */ }
          }
        }, 3000)
        forceTimer.unref?.()
      }

      const timer = setTimeout(() => forceStop(`timeout after ${Math.round(timeoutMs / 1000)}s`), timeoutMs)
      timer.unref?.()

      const processLine = (line) => {
        if (!line.trim()) return
        let event
        try { event = JSON.parse(line) } catch { return }
        if (event.type !== 'message_end' || !event.message) return
        const msg = event.message
        if (msg.role !== 'assistant') return
        messages.push(msg)
        turns++
        if (msg.stopReason) stopReason = msg.stopReason
        if (msg.errorMessage) errorMessage = msg.errorMessage
      }

      proc.stdout?.on('data', (data) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) processLine(line)
      })
      proc.stderr?.on('data', (data) => {
        stderr = appendBounded(stderr, data.toString())
      })

      const onAbort = () => forceStop('aborted by caller')
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })

      proc.on('close', (code) => {
        closed = true
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        signal?.removeEventListener('abort', onAbort)
        if (buffer.trim()) processLine(buffer)
        finish(code ?? 1)
      })
      proc.on('error', (error) => {
        errorMessage ||= error.message
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        signal?.removeEventListener('abort', onAbort)
        finish(1)
      })
    })

    let result = ''
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const part of messages[i].content ?? []) {
        if (part.type === 'text' && part.text) {
          result = part.text
          break
        }
      }
      if (result) break
    }
    const stderrDetail = stderr.trim().split(/\r?\n/).slice(-8).join(' | ')
    const error = errorMessage || stderrDetail || `exit ${exitCode}, stop: ${stopReason || '?'}`
    const ok = childAttemptSucceeded({ exitCode, terminationRequested, errorMessage, stopReason, result })
    const sources = extractSourceUrls(result)
    return {
      agent: item.agent,
      task: item.task,
      ok,
      result: result || error || '(no output)',
      tookMs: Date.now() - started,
      turns,
      attempts: 1,
      sources,
      domains: [...new Set(sources.map(hostOf).filter(Boolean))],
      error: ok ? undefined : error,
    }
  } finally {
    if (tmpPrompt) {
      try { fs.unlinkSync(tmpPrompt) } catch { /* ignore */ }
    }
    if (tmpDir) {
      try { fs.rmdirSync(tmpDir) } catch { /* ignore */ }
    }
  }
}

export async function retryTransientSubtasks(results, signal, progress, attempt) {
  for (let i = 0; i < results.length; i++) {
    const first = results[i]
    const diagnostic = `${first.error ?? ''}\n${first.result}`
    if (first.ok || signal?.aborted || !isTransientProviderTransportError(diagnostic)) continue
    progress?.(`task ${i + 1}: transient provider transport failure; retrying serially`)
    const retry = await attempt({ agent: first.agent, task: first.task })
    retry.attempts = 2
    retry.tookMs += first.tookMs
    retry.turns += first.turns
    if (!retry.ok) {
      retry.error = `${first.error ?? 'first attempt failed'}; retry: ${retry.error ?? 'failed'}`
      if (/websocket/i.test(diagnostic + retry.error)) {
        retry.error += '; WebSocket failed twice — set pi "transport" to "auto" or "sse" in ~/.pi/agent/settings.json'
      }
    }
    results[i] = retry
  }
}

export async function runSearchParallel(opts) {
  const started = Date.now()
  const items = opts.tasks
  const timeoutMs = Math.min(600, Math.max(30, opts.timeoutSeconds ?? 150)) * 1000
  const dispatch = opts.dispatch ?? {}

  opts.progress?.(`search-parallel-subagent: ${items.length} task(s), all concurrent`)
  const results = await Promise.all(items.map((item, index) => {
    opts.progress?.(`task ${index + 1}/${items.length}: ${item.agent} "${item.task.slice(0, 60)}"`)
    return runAgentAttempt(item, timeoutMs, opts.signal, dispatch)
  }))

  await retryTransientSubtasks(
    results,
    opts.signal,
    opts.progress,
    (item) => runAgentAttempt(item, timeoutMs, opts.signal, dispatch),
  )

  const sourceUrls = [...new Set(results.flatMap((result) => result.sources))]
  const domains = [...new Set(sourceUrls.map(hostOf).filter(Boolean))]
  return {
    results,
    okCount: results.filter((result) => result.ok).length,
    sourceUrls,
    domains,
    totalTurns: results.reduce((sum, result) => sum + result.turns, 0),
    totalMs: Date.now() - started,
  }
}
