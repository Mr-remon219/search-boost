// Audit log (JSONL, append-only) — records search / fetch / research / x_search
// events so real usage can be analyzed (loops, failing domains, credit spend).
// Rotated at 5MB (keeps one .old). Ported from pi-search-boost lib/audit.ts.
//
// Host-neutral: the file path is chosen by the host adapter (pi keeps
// <agentDir>/search-boost-audit.jsonl). Writes never throw.

import * as fs from 'node:fs'
import * as path from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

/**
 * @typedef {{ type: 'search', ts: string, query: string, queriesUsed: string[], engines: string[],
 *   engineErrors: Record<string, string>, results: number, cacheHits: number, tier?: string, layer?: string,
 *   tookMs: number, topUrls: string[] }} AuditSearchEvent
 * @typedef {{ type: 'fetch', ts: string, url: string, domain: string, via: string, ok: boolean, error?: string,
 *   wordCount?: number, bytes?: number, cacheHit: boolean, tookMs: number }} AuditFetchEvent
 * @typedef {{ type: 'research', ts: string, query: string, mode: string, rounds: number, stopReason: string,
 *   sources: number, domains: number, uncovered: string[], tookMs: number, subtasks?: number,
 *   successfulSubtasks?: number, turns?: number }} AuditResearchEvent
 * @typedef {{ type: 'xsearch', ts: string, subtype: string, query?: string, postId?: string, results: number,
 *   cacheHit: boolean, credential?: string, error?: string, tookMs: number }} AuditXSearchEvent
 * @typedef {AuditSearchEvent | AuditFetchEvent | AuditResearchEvent | AuditXSearchEvent} AuditEvent
 */

export class AuditLog {
  /** @param {string} filePath */
  constructor(filePath) {
    this.file = filePath
    this.bytes = 0
    try {
      if (fs.existsSync(filePath)) this.bytes = fs.statSync(filePath).size
    } catch { /* ignore */ }
  }

  /** @param {AuditEvent} evt */
  write(evt) {
    try {
      const line = JSON.stringify(evt) + '\n'
      if (this.bytes + line.length > MAX_BYTES) {
        try {
          fs.renameSync(this.file, `${this.file}.old`)
        } catch { /* ignore */ }
        this.bytes = 0
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, line, 'utf8')
      this.bytes += line.length
    } catch {
      /* audit must never break search */
    }
  }

  /** Read the last N events (current + .old, chronological). @returns {AuditEvent[]} */
  readTail(n) {
    const out = []
    for (const f of [`${this.file}.old`, this.file]) {
      try {
        if (!fs.existsSync(f)) continue
        const size = fs.statSync(f).size
        const fd = fs.openSync(f, 'r')
        const CHUNK = 64 * 1024
        let pos = Math.max(0, size - CHUNK)
        let buffer = ''
        try {
          // read from the tail backwards; a file smaller than one chunk is read
          // in a single pass (pos === 0 must still read, not skip the loop)
          while (true) {
            const b = Buffer.alloc(Math.min(CHUNK, size - pos))
            fs.readSync(fd, b, 0, b.length, pos)
            buffer = b.toString('utf8') + buffer
            if (pos === 0 || buffer.length > n * 400) break
            pos = Math.max(0, pos - CHUNK)
          }
        } finally {
          fs.closeSync(fd)
        }
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch { /* skip corrupt line */ }
        }
      } catch { /* ignore */ }
    }
    return out.slice(-n)
  }

  /** Read all events (current + .old, chronological). @returns {AuditEvent[]} */
  readAll() {
    const out = []
    for (const f of [`${this.file}.old`, this.file]) {
      try {
        if (!fs.existsSync(f)) continue
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch { /* skip corrupt line */ }
        }
      } catch { /* ignore */ }
    }
    return out
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true })
      fs.rmSync(`${this.file}.old`, { force: true })
      this.bytes = 0
    } catch { /* ignore */ }
  }
}

/** No-op sink for hosts that do not enable auditing. */
export const NULL_AUDIT = {
  write() {},
  readTail() { return [] },
  readAll() { return [] },
  clear() {},
}
