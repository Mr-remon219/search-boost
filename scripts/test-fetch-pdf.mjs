#!/usr/bin/env node
import './isolate-tests.mjs'
// Hermetic PDF/binary/window regressions for fetch_page. No external sites, no
// user credentials: the network is always a stub and the PDF fixtures are built
// here. The pdfjs-dist path is optional, exactly like the dependency itself.
import assert from 'node:assert/strict'
import { fetchPage, makePageCache, PAGE_WINDOW_CHARS, windowPageResult, toFetchPageResult } from '../lib/search/fetch.js'
import { assemblePdfPageText, isPlausibleText, looksBinary, looksBinaryType, looksLikePdf, pdfAssetPrefix, PDF_MAX_PAGES, __setPdfParserForTests } from '../lib/search/pdf.js'
import { __setUndiciLoaderForTests, closeFetchDispatchers } from '../lib/search/ipv4-fetch.js'
import { NET_ERROR_KINDS } from '../lib/search/net-policy.mjs'

const undici = await import('undici')
const prose = 'Useful documentation with enough substance for extraction. '.repeat(20)
let passed = 0

async function test(name, action) {
  try {
    await action()
    passed++
    console.log(`ok: ${name}`)
  } catch (err) {
    process.exitCode = 1
    console.error(`FAIL: ${name}\n${err.stack}`)
  } finally {
    __setUndiciLoaderForTests(null)
    __setPdfParserForTests(null)
    await closeFetchDispatchers()
  }
}

/** Stub every origin/reader request; returns the list of requested URLs. */
function stubNetwork(handler) {
  const seen = []
  __setUndiciLoaderForTests(async () => ({
    ...undici,
    fetch: async (url, options) => {
      seen.push(String(url))
      return handler(String(url), options)
    },
  }))
  return seen
}

const html = (text) => new Response(`<html><body><p>${text}</p></body></html>`, { headers: { 'content-type': 'text/html' } })
const pdfResponse = (bytes) => new Response(bytes, { headers: { 'content-type': 'application/pdf' } })

// ---------------------------------------------------------------------------
// Fixture: a deterministic text-only PDF (Helvetica, uncompressed streams)
// ---------------------------------------------------------------------------
function makePdf(pages) {
  const objects = []
  const add = (body) => { objects.push(body); return objects.length }
  const stream = (lines) => ['BT', '/F1 12 Tf', '72 720 Td', '14 TL',
    ...lines.map((line) => `(${String(line).replace(/([\\()])/g, '\\$1')}) Tj`), 'T*'].join('\n')
  const fontObj = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const contentIds = pages.map((lines) => {
    const body = `${stream(lines)}\nET`
    return add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`)
  })
  const pagesId = objects.length + pages.length + 1
  const pageIds = pages.map((_, i) => add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`))
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`)
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const fixturePdf = makePdf([
  ['Retrieval augmented generation cites retrieved sources.', 'Long context models read whole documents instead.'],
  ['A middle page discusses unrelated weather observations.', 'Nothing here concerns retrieval quality at all.'],
  ['The final page reports measured latency and cost.', 'Token cost differs by one order of magnitude.'],
])

let realPdfParser = null
try {
  realPdfParser = await import('pdfjs-dist/legacy/build/pdf.mjs')
} catch { /* optional dependency is absent; the injected-parser tests still run */ }

// ---------------------------------------------------------------------------
// Detection units
// ---------------------------------------------------------------------------
await test('detection distinguishes PDF, text and binary bodies', async () => {
  assert.equal(looksLikePdf(fixturePdf), true)
  assert.equal(looksLikePdf(fixturePdf, 'text/html'), true, 'magic bytes beat a wrong content-type')
  assert.equal(looksLikePdf(Buffer.from('<html><body>no pdf here</body></html>')), false)
  assert.equal(looksLikePdf(Buffer.from('<p>a page that discusses %PDF- headers</p>')), true, 'the documented weak signal is intentional')
  assert.equal(looksBinaryType('application/octet-stream'), true)
  assert.equal(looksBinaryType('image/png'), true)
  assert.equal(looksBinaryType('text/html; charset=utf-8'), false)
  assert.equal(looksBinary(Buffer.from('{"json": true}\n')), false)
  assert.equal(looksBinary(Buffer.alloc(700, 0)), true)
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(700).fill(0x01)])), true)
  assert.equal(isPlausibleText('ordinary extracted text'), true)
  assert.equal(isPlausibleText('\u0000\u0000'), false)
  assert.equal(isPlausibleText('\uFFFD'.repeat(200)), false)
  assert.equal(isPlausibleText('   '), false)
})

await test('page text assembly uses vertical position, gaps and explicit line breaks', async () => {
  const text = assemblePdfPageText([
    { str: 'First line', hasEOL: true, width: 55, height: 12, transform: [12, 0, 0, 12, 72, 720] },
    { str: 'Second line', hasEOL: false, width: 62, height: 12, transform: [12, 0, 0, 12, 72, 706] },
    { str: 'same baseline continuation', hasEOL: false, width: 150, height: 12, transform: [12, 0, 0, 12, 140, 706] },
    { str: 'Next block', hasEOL: false, width: 60, height: 12, transform: [12, 0, 0, 12, 72, 650] },
  ])
  assert.equal(text, 'First line\nSecond line same baseline continuation\nNext block')
  // A kerning-level gap inside one word must not become a word space.
  assert.equal(assemblePdfPageText([
    { str: 'Def', hasEOL: false, width: 20, height: 12, transform: [12, 0, 0, 12, 72, 700] },
    { str: 'inition', hasEOL: false, width: 30, height: 12, transform: [12, 0, 0, 12, 92.4, 700] },
  ]), 'Definition')
  assert.equal(assemblePdfPageText([]), '')
})

// ---------------------------------------------------------------------------
// The regression that broke the run: a PDF must become text, never mojibake
// ---------------------------------------------------------------------------
if (!realPdfParser) {
  console.log('skip: real pdfjs-dist extraction — optional dependency is not installed')
} else {
  await test('a PDF is read as text: no raw bytes, no mojibake, no second request', async () => {
    const seen = stubNetwork(() => pdfResponse(fixturePdf))
    const cache = makePageCache()
    const url = 'https://example.test/paper.pdf'
    const page = await fetchPage(url, undefined, cache)
    assert.equal(page.via, 'pdf')
    assert.match(page.content, /Retrieval augmented generation cites retrieved sources\./)
    assert.match(page.content, /The final page reports measured latency and cost\./)
    assert.doesNotMatch(page.content, /%PDF|endobj|startxref/, 'PDF structure must not leak into content')
    assert.equal(looksBinary(Buffer.from(page.content)), false)
    assert.equal(isPlausibleText(page.content), true)
    assert.equal(seen.length, 1, 'local extraction must not call the reader')
    assert.equal(page.truncated, false)
    // The 24h cache serves the same text without a new request, and focus
    // filtering works on page-level paragraphs: the matching page is kept with
    // one paragraph of context, the distant unrelated page is dropped.
    const focused = await fetchPage(url, 'latency', cache)
    assert.equal(focused.cacheHit, true)
    assert.equal(focused.via, 'cache')
    assert.match(focused.content, /latency and cost/)
    assert.doesNotMatch(focused.content, /Retrieval augmented generation/, 'focus keeps matching paragraphs and their context only')
    assert.ok(focused.content.length < page.content.length)
    assert.equal(seen.length, 1)
  })

  await test('a broken PDF body never becomes content: the reader is used, then an error is raised', async () => {
    // 900k of unparsable bytes behind a PDF magic header — the exact shape that
    // used to be delivered as ~860k characters of mojibake.
    const broken = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 900_000 }, (_, i) => (i * 37) % 256))])
    const readerOnly = stubNetwork((url) => url.startsWith('https://r.jina.ai/') ? new Response(prose) : pdfResponse(broken))
    const recovered = await fetchPage('https://example.test/broken.pdf', undefined, makePageCache())
    assert.equal(recovered.via, 'jina')
    assert.match(recovered.content, /Useful documentation/)
    assert.ok(recovered.content.length < 100_000, `reader text must be bounded, got ${recovered.content.length}`)
    assert.equal(readerOnly.length, 2)

    // With the reader down as well, the failure is reported instead of the bytes.
    stubNetwork(() => pdfResponse(broken))
    await assert.rejects(
      () => fetchPage('https://example.test/broken.pdf', undefined, makePageCache()),
      (err) => {
        assert.ok(err.message.length < 2000, 'the error must not carry the body')
        assert.match(err.message, /PDF/)
        return true
      },
    )
  })

  await test('a PDF that hits the extraction bound reports what was extracted', async () => {
    stubNetwork(() => pdfResponse(fixturePdf))
    __setPdfParserForTests({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: PDF_MAX_PAGES + 1,
          getPage: async (n) => ({ getTextContent: async () => ({ items: [{ str: `Page ${n} carries a sentence of extractable text.`, hasEOL: true, transform: [1, 0, 0, 1, 72, 720] }] }), cleanup() {} }),
          destroy: async () => {},
        }),
      }),
    })
    const page = await fetchPage('https://example.test/many.pdf', undefined, makePageCache())
    assert.equal(page.via, 'pdf')
    assert.match(page.content, /Page 1 carries a sentence of extractable text\./)
    assert.equal(page.limitation.kind, 'pdf_truncated')
    assert.match(page.limitation.message, new RegExp(`${PDF_MAX_PAGES} of ${PDF_MAX_PAGES + 1} page`))
  })

  await test('a PDF whose pages carry no text reports no readable text, not truncation', async () => {
    stubNetwork(() => pdfResponse(fixturePdf))
    __setPdfParserForTests({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }),
          destroy: async () => {},
        }),
      }),
    })
    await assert.rejects(
      () => fetchPage('https://example.test/scanned.pdf', undefined, makePageCache()),
      (err) => {
        assert.match(err.message, /no extractable text/)
        assert.ok(!err.message.includes('\uFFFD'))
        return true
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Injected parser: available, failing, and absent (optional dependency paths)
// ---------------------------------------------------------------------------
await test('an injected parser produces pdf text without the real dependency', async () => {
  stubNetwork(() => pdfResponse(fixturePdf))
  __setPdfParserForTests({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Extracted by the injected parser.', hasEOL: true, transform: [1, 0, 0, 1, 72, 720] }] }), cleanup() {} }),
        destroy: async () => {},
      }),
    }),
  })
  const page = await fetchPage('https://example.test/injected.pdf', undefined, makePageCache())
  assert.equal(page.via, 'pdf')
  assert.equal(page.content, 'Extracted by the injected parser.')
})

await test('a failing parser falls back to the reader instead of the bytes', async () => {
  const seen = stubNetwork((url) => url.startsWith('https://r.jina.ai/') ? new Response(prose) : pdfResponse(fixturePdf))
  __setPdfParserForTests({
    getDocument: () => ({ promise: Promise.reject(Object.assign(new Error('bad xref'), { name: 'InvalidPDFException' })) }),
  })
  const page = await fetchPage('https://example.test/failing.pdf', undefined, makePageCache())
  assert.equal(page.via, 'jina')
  assert.match(page.content, /Useful documentation/)
  assert.equal(seen.length, 2)
})

await test('an unavailable parser and a failing reader report a PDF error, not content', async () => {
  stubNetwork(() => pdfResponse(fixturePdf))
  const saved = globalThis.fetch
  __setPdfParserForTests({ getDocument: null })
  await assert.rejects(
    () => fetchPage('https://example.test/noparser.pdf', undefined, makePageCache()),
    (err) => {
      assert.equal(err.kind, NET_ERROR_KINDS.unsupported)
      assert.match(err.message, /PDF text extractor|reader failed/)
      return true
    },
  )
  globalThis.fetch = saved
})

await test('PDF asset prefixes use the forward-slash form PDF.js requires', async () => {
  // PDF.js only checks that the value ends with "/" and then reads it as a path
  // prefix, so a Windows separator is rejected on Windows runners.
  assert.equal(pdfAssetPrefix('C:\\a\\search-boost\\node_modules\\pdfjs-dist\\cmaps'), 'C:/a/search-boost/node_modules/pdfjs-dist/cmaps/')
  assert.equal(pdfAssetPrefix('/home/u/nm/pdfjs-dist/standard_fonts/'), '/home/u/nm/pdfjs-dist/standard_fonts/')
  assert.equal(pdfAssetPrefix('cmaps\\'), 'cmaps/')
  for (const value of [pdfAssetPrefix('C:\\a\\cmaps'), pdfAssetPrefix('/a/cmaps')]) assert.ok(value.endsWith('/') && !value.includes('\\'))
})

await test('a rejected asset prefix does not cost the whole extraction, a real parse error is not retried', async () => {
  stubNetwork(() => pdfResponse(fixturePdf))
  let attempts = 0
  __setPdfParserForTests({
    getDocument: (params) => {
      attempts++
      if (attempts === 1) return { promise: Promise.reject(new Error('Invalid factory url: "x" must include trailing slash.')) }
      assert.equal(params.cMapUrl, undefined, 'the retry drops the optional prefixes')
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Text without bundled assets.', hasEOL: true, transform: [12, 0, 0, 12, 72, 720] }] }), cleanup() {} }),
          destroy: async () => {},
        }),
      }
    },
  })
  const page = await fetchPage('https://example.test/assets.pdf', undefined, makePageCache())
  assert.equal(page.via, 'pdf')
  assert.equal(page.content, 'Text without bundled assets.')
  assert.equal(attempts, 2)

  let failed = 0
  __setPdfParserForTests({ getDocument: () => { failed++; return { promise: Promise.reject(new Error('bad xref table')) } } })
  await assert.rejects(
    () => fetchPage('https://example.test/badxref.pdf', undefined, makePageCache()),
    (err) => {
      assert.match(err.message, /could not be extracted/)
      return true
    },
  )
  assert.equal(failed, 1, 'an unrelated parse failure is reported, not retried')
})

// ---------------------------------------------------------------------------
// Binary bodies
// ---------------------------------------------------------------------------
await test('a declared binary body is refused or read by the reader, never returned', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)])
  const binary = () => new Response(png, { headers: { 'content-type': 'image/png' } })
  stubNetwork(binary)
  await assert.rejects(
    () => fetchPage('https://example.test/image.png', undefined, makePageCache()),
    (err) => {
      assert.equal(err.kind, NET_ERROR_KINDS.unsupported)
      assert.match(err.message, /not text/)
      assert.match(err.message, /image\/png/)
      return true
    },
  )

  const seen = stubNetwork((url) => url.startsWith('https://r.jina.ai/') ? new Response(prose) : binary())
  const page = await fetchPage('https://example.test/image.png', undefined, makePageCache())
  assert.equal(seen.length, 2)
  assert.equal(page.via, 'jina')
  assert.match(page.content, /Useful documentation/)
  assert.doesNotMatch(page.content, /\uFFFD/, 'no replacement characters from a binary body')
})

await test('a binary response from the reader is not accepted as page text', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)])
  stubNetwork(() => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }))
  await assert.rejects(
    () => fetchPage('https://example.test/blob', undefined, makePageCache()),
    (err) => {
      assert.match(err.message, /not text/)
      assert.ok(!err.message.includes('\uFFFD'))
      return true
    },
  )
})

await test('text that cannot be decoded is refused like binary, but a stray odd byte is not', async () => {
  // A GBK-style body: every byte is invalid UTF-8, so decoding produces
  // replacement characters — unreadable content that must not be reported as a
  // successful read.
  const bytes = Buffer.alloc(2000, 0xb2)
  const mojibake = () => new Response(bytes, { headers: { 'content-type': 'text/html' } })
  stubNetwork(mojibake)
  await assert.rejects(
    () => fetchPage('https://example.test/gbk', undefined, makePageCache()),
    (err) => {
      assert.equal(err.kind, NET_ERROR_KINDS.unsupported)
      assert.match(err.message, /not decodable text/)
      return true
    },
  )

  const seen = stubNetwork((url) => url.startsWith('https://r.jina.ai/') ? new Response(prose) : mojibake())
  const page = await fetchPage('https://example.test/gbk', undefined, makePageCache())
  assert.equal(seen.length, 2, 'the reader backup must be attempted before failing')
  assert.equal(page.via, 'jina')
  assert.match(page.content, /Useful documentation/)
  assert.doesNotMatch(page.content, /\uFFFD/)

  // One odd byte in otherwise readable text keeps normal delivery.
  stubNetwork(() => new Response(Buffer.concat([
    Buffer.from(`<p>${prose} odd byte `), Buffer.from([0xb2]), Buffer.from(' and normal text after it.</p>'),
  ]), { headers: { 'content-type': 'text/html' } }))
  const mixed = await fetchPage('https://example.test/mixed', undefined, makePageCache())
  assert.equal(mixed.via, 'local')
  assert.match(mixed.content, /Useful documentation/)
})

// ---------------------------------------------------------------------------
// Bounded model-facing windows
// ---------------------------------------------------------------------------
await test('a long body is returned in bounded windows that continue from cache', async () => {
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} repeats a sentence for the window test.`).join('\n\n')
  const seen = stubNetwork(() => html(long))
  const cache = makePageCache()
  const url = 'https://example.test/long'

  const first = await fetchPage(url, undefined, cache, undefined, { windowChars: 1000 })
  assert.equal(first.content.length, 1000)
  assert.ok(first.totalChars > 2000, `body should exceed two windows, got ${first.totalChars}`)
  assert.equal(first.offset, 0)
  assert.equal(first.nextOffset, 1000)
  assert.equal(first.truncated, true)
  assert.match(first.windowNote, /characters 0–1000 of \d+/)

  const second = await fetchPage(url, undefined, cache, undefined, { offset: first.nextOffset, windowChars: 1000 })
  assert.equal(second.cacheHit, true, 'continuing a read must not hit the network again')
  assert.equal(second.offset, 1000)
  assert.equal(second.nextOffset, 2000)
  assert.equal(seen.length, 1)

  // Walking the windows reproduces the whole body exactly.
  const full = await fetchPage(url, undefined, cache, undefined, { windowChars: Infinity })
  let rebuilt = ''
  for (let offset = 0; offset !== undefined;) {
    const page = await fetchPage(url, undefined, cache, undefined, { offset, windowChars: 1000 })
    rebuilt += page.content
    offset = page.nextOffset
  }
  assert.equal(rebuilt, full.content)
  assert.equal(seen.length, 1)

  const past = await fetchPage(url, undefined, cache, undefined, { offset: full.totalChars + 10 })
  assert.equal(past.content, '')
  assert.equal(past.nextOffset, undefined)
  assert.match(past.windowNote, /past the end/)
})

await test('the default window is a hard cap for model-facing content', async () => {
  const huge = `<p>${'word '.repeat(20_000)}</p>`
  stubNetwork(() => html(huge))
  const page = await fetchPage('https://example.test/huge', undefined, makePageCache())
  assert.equal(page.content.length, PAGE_WINDOW_CHARS)
  assert.equal(page.totalChars > PAGE_WINDOW_CHARS, true)
  assert.equal(page.truncated, true)
  assert.equal(page.nextOffset, PAGE_WINDOW_CHARS)

  const shaped = toFetchPageResult('https://example.test/huge', 'local', 'word '.repeat(20_000), undefined, false, Date.now())
  assert.equal(shaped.truncated, false, 'the full body constructor stays unclipped')
  assert.equal(windowPageResult(shaped, 0).content.length, PAGE_WINDOW_CHARS)
  assert.equal(windowPageResult(toFetchPageResult('u', 'local', 'short body', undefined, false, Date.now()), 0).truncated, false)
})

console.log(`${passed} fetch PDF/binary/window tests passed${realPdfParser ? '' : ' (real pdfjs-dist tests skipped)'}`)
