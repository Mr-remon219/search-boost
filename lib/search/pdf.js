// PDF text extraction and binary-response detection for fetch_page.
//
// A PDF is not HTML. Decoding its bytes as UTF-8 produced hundreds of thousands
// of mojibake characters, which then entered the agent's context as if they were
// page text and exhausted the model window. This module exists so that failure
// cannot reach a caller:
//
//   looksLikePdf()   magic bytes or content-type, checked BEFORE any decoding
//   looksBinary()    NUL bytes / control-character density for other byte bodies
//   extractPdfText() real page text from the PDF, never the raw stream
//
// A missing parser is not fatal: PDF.js is an optional dependency, and the
// caller falls back to the reader backup. Extracted text is plain text, so no
// HTML chrome stripping applies and no summary is invented.
//
// Bounds: returned/cached text stops at PDF_MAX_PAGES / PDF_MAX_CHARS. Abort
// races asynchronous parser operations and requests parser destruction. PDF.js
// still parses in-process: these are not hard CPU/heap sandbox limits. CJK glyphs
// need the bundled CMaps; when the package directory cannot be resolved, only
// those glyphs are affected.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PDF_MAGIC_HEAD_BYTES = 1024

/** Bounds on retained text/pages, not on PDF.js internal allocations. */
export const PDF_MAX_PAGES = 400
export const PDF_MAX_CHARS = 2_000_000

/** Content types that are never page text. PDF is handled before this list. */
const BINARY_CONTENT_TYPE =
  /^(?:image|video|audio|font)\/|^application\/(?:octet-stream|zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|x-tar|x-bzip2|wasm|java-archive|epub\+zip|vnd\.ms-|vnd\.openxmlformats|vnd\.mozilla\.pdf|x-shockwave-flash|x-msdownload|x-msdos-program|x-apple-diskimage)/i

let injectedParser = null
let parserPromise

/** Hosts and tests may supply a pdfjs-compatible module. Pass null to reset. */
export function __setPdfParserForTests(parser) {
  injectedParser = parser
  parserPromise = undefined
}

/**
 * Is this body a PDF? A response that claims PDF is trusted (the parser then
 * decides whether it is readable); otherwise the magic must be in the head,
 * so a mislabeled file is still recognized.
 */
export function looksLikePdf(bytes, contentType = '') {
  if (typeof contentType === 'string' && /application\/(?:x-)?pdf\b/i.test(contentType)) return true
  if (!bytes?.length) return false
  const head = Buffer.from(bytes.subarray(0, PDF_MAGIC_HEAD_BYTES)).toString('latin1')
  // Require a header at the start (allow BOM/whitespace), not an HTML paragraph
  // quoting the PDF signature. Buffer and Uint8Array inputs behave identically.
  return /^(?:\xEF\xBB\xBF)?\s*%PDF-\d\.\d/.test(head)
}

/** The response declares a format that can never be delivered as page text. */
export function looksBinaryType(contentType = '') {
  return BINARY_CONTENT_TYPE.test(String(contentType).trim())
}

/**
 * Byte-level text check for bodies whose type is unknown or mislabeled. NUL is
 * decisive (no text encoding we decode uses it); otherwise density of control
 * characters separates binary from text. Applied to decoded text too, so a
 * parser that returns glyph noise is not mistaken for evidence.
 */
export function looksBinary(bytes) {
  if (!bytes?.length) return false
  const sample = bytes
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    // \t \n \v \f \r are the only control bytes real text uses
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / sample.length > 0.10
}

/** Text that survives extraction must still look like text, not replacement noise. */
export function isPlausibleText(text = '') {
  const value = String(text)
  if (!value.trim()) return false
  if (value.includes('\u0000')) return false
  const sample = value
  const broken = (sample.match(/\uFFFD/g) ?? []).length
  return broken / sample.length <= 0.02
}

/**
 * One page's items as text. PDF text runs carry no newline or space operator, so
 * both come from geometry: a vertical jump starts a new line, and a horizontal
 * gap wider than a fraction of the font size is a word space. Kerning-level
 * gaps between runs of one word stay glued, which is why the tolerance is
 * relative to the font size rather than any positive offset.
 */
export function assemblePdfPageText(items = []) {
  const lines = []
  let current = ''
  let lastY = null
  let lastEndX = null
  const flush = () => { lines.push(current.trim()); current = ''; lastEndX = null }
  for (const item of items ?? []) {
    if (!item || typeof item.str !== 'string') continue
    const transform = Array.isArray(item.transform) ? item.transform : null
    const y = Number.isFinite(transform?.[5]) ? transform[5] : null
    const x = Number.isFinite(transform?.[4]) ? transform[4] : null
    const size = Math.abs(transform?.[3] ?? 0) || item.height || 10
    if (current && y !== null && lastY !== null && Math.abs(y - lastY) > 1.5) flush()
    else if (current && x !== null && lastEndX !== null && x - lastEndX > size * 0.2
      && !/\s$/.test(current) && !/^\s/.test(item.str)) current += ' '
    current += item.str
    if (item.hasEOL) flush()
    else if (x !== null && Number.isFinite(item.width)) lastEndX = x + item.width
    else if (x !== null) lastEndX = null
    if (y !== null) lastY = y
  }
  if (current.trim()) flush()
  return lines.join('\n').trim()
}

/** Resolve the installed parser once, or null when PDF.js is unavailable. */
export async function loadPdfParser() {
  if (injectedParser) return injectedParser
  // Publish the pending operation, not an availability flag. Concurrent first
  // reads must await the same result; a caller's abort only cancels its own wait.
  parserPromise ??= resolvePdfParser()
  return parserPromise
}

async function resolvePdfParser() {
  // Native dynamic import first (keeps ESM semantics); a host that transpiles
  // imports may fail here, so the CommonJS require path is tried as well.
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (typeof mod?.getDocument === 'function') return mod
  } catch { /* try the require path */ }
  try {
    const mod = createRequire(import.meta.url)('pdfjs-dist/legacy/build/pdf.mjs')
    if (typeof mod?.getDocument === 'function') return mod
  } catch { /* no parser available */ }
  return null
}

/**
 * A factory-URL prefix for the bundled assets. PDF.js only accepts a value that
 * ends with a forward slash (and then reads it as a path prefix), so Windows
 * separators must be normalized: `...\\cmaps\\` is rejected outright.
 */
export function pdfAssetPrefix(dir) {
  return `${String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).join('/')}/`
}

/** Bundled CMaps/standard fonts, when the package directory resolves. */
function assetUrls() {
  try {
    const encoded = import.meta.resolve?.('pdfjs-dist/package.json')
    if (!encoded) return {}
    const root = dirname(fileURLToPath(encoded))
    const cmaps = join(root, 'cmaps')
    const fonts = join(root, 'standard_fonts')
    return {
      ...(existsSync(cmaps) ? { cMapUrl: pdfAssetPrefix(cmaps) } : {}),
      ...(existsSync(fonts) ? { standardFontDataUrl: pdfAssetPrefix(fonts) } : {}),
    }
  } catch { return {} }
}

/**
 * Load the document, retrying without the optional asset prefixes. They carry
 * CMaps and standard fonts while PDF.js validates their shape; an auxiliary
 * asset must never cost the whole extraction.
 */
async function loadPdfDocument(lib, bytes, assets, signal, onTask) {
  // A fresh copy per attempt: PDF.js transfers the buffer to its worker, which
  // detaches it, so a retry cannot reuse the previous attempt's array.
  const attempt = (extra) => {
    signal?.throwIfAborted()
    const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0, ...extra })
    onTask(task)
    return waitForPdf(task.promise, signal)
  }
  try {
    return await attempt(assets)
  } catch (err) {
    if (signal?.aborted || !Object.keys(assets).length || !/factory url/i.test(String(err?.message ?? ''))) throw err
    return await attempt({})
  }
}

// Observe both settlement and abort without leaving rejection handlers/listeners
// behind. Cancellation of the actual parser is requested separately in finally.
async function waitForPdf(operation, signal) {
  const pending = Promise.resolve(operation)
  if (!signal) return pending
  // Observe even an already-created rejected operation when aborted up front.
  pending.catch(() => {})
  signal.throwIfAborted()
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('PDF extraction cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const value = await Promise.race([pending, aborted])
    signal.throwIfAborted()
    return value
  } finally { signal.removeEventListener('abort', onAbort) }
}

/**
 * @param {Buffer|Uint8Array} bytes — raw PDF bytes (never decoded as text)
 * @param {{ signal?: AbortSignal, parser?: object, maxPages?: number, maxChars?: number }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: string, text: string, pages?: number,
 *   totalPages?: number, chars?: number, truncated?: boolean }>}
 */
export async function extractPdfText(bytes, { signal, parser = null, maxPages = PDF_MAX_PAGES, maxChars = PDF_MAX_CHARS } = {}) {
  if (!bytes?.length) return { ok: false, reason: 'empty_body', text: '' }
  let doc = null
  let loadingTask = null
  try {
    signal?.throwIfAborted()
    const lib = parser ?? await waitForPdf(loadPdfParser(), signal)
    if (typeof lib?.getDocument !== 'function') return { ok: false, reason: 'parser_unavailable', text: '' }
    doc = await loadPdfDocument(lib, bytes, assetUrls(), signal, task => { loadingTask = task })
    const total = doc.numPages
    const chunks = []
    let chars = 0
    let pages = 0
    let bounded = false
    for (let n = 1; n <= total; n++) {
      if (signal?.aborted) return { ok: false, reason: 'cancelled', text: '' }
      // Only the explicit bounds truncate: a page without text (a full-page
      // figure) is normal and must not be reported as missing material.
      if (n > maxPages || chars >= maxChars) { bounded = true; break }
      const page = await waitForPdf(doc.getPage(n), signal)
      const content = await waitForPdf(page.getTextContent(), signal)
      const text = assemblePdfPageText(content.items)
      page.cleanup()
      if (text) {
        const separator = chunks.length ? '\n\n' : ''
        const remaining = maxChars - chars
        const chunk = separator + text
        chunks.push(chunk.slice(0, remaining))
        chars += Math.min(chunk.length, remaining)
        pages++
        if (chunk.length > remaining) { bounded = true; break }
      }
    }
    signal?.throwIfAborted()
    const text = chunks.join('')
    if (!text.trim()) return { ok: false, reason: 'no_text', text: '' }
    return { ok: true, text, pages, totalPages: total, chars, truncated: bounded }
  } catch (err) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled', text: '' }
    const name = err?.name ?? ''
    return {
      ok: false,
      reason: name === 'PasswordException' ? 'password_protected' : 'extract_failed',
      detail: err instanceof Error ? err.message : String(err),
      text: '',
    }
  } finally {
    // A hung parser/cleanup must not hold a cancelled request open. The real
    // loading task owns teardown, including an unresolved document load.
    const owner = typeof loadingTask?.destroy === 'function' ? loadingTask : doc
    const cleanup = Promise.resolve().then(() => owner?.destroy()).catch(() => {})
    if (!signal?.aborted) {
      try { await waitForPdf(cleanup, signal) } catch { /* best effort */ }
    }
  }
}

/** Extracted PDF text as plain paragraphs, without HTML or markdown rewriting. */
export function normalizePdfText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
