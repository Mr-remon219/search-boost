/**
 * Opt-in private snapshots: public materials + typed response metadata, not live
 * cursors or model logs.
 *
 * Two formats are supported and never mixed up:
 *  - search-boost-research-v2 (write path): a schema-v5 run, validated against the
 *    shared v5 metadata contract.
 *  - search-boost-research-v1 (read-only legacy): the frozen keyword-era data
 *    shape, decoded with the legacy whitelist. It is never rewritten, re-scored
 *    or upgraded in place, and a bad v2 file is never downgraded to v1.
 */
import { randomUUID } from 'node:crypto'
import { constants, existsSync, readdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as z from 'zod'
import { searchBoostHome } from './config-paths.mjs'
import { writeFileAtomicPrivate } from './private-file.mjs'
import { ADAPTIVE_V5_METADATA_SCHEMA, ADAPTIVE_V5_OUTPUT_SCHEMA } from './search/screening/schema.js'
import { jsonSchemaToZod } from './search/screening/zod-schema.js'
import { LEGACY_SNAPSHOT_FORMAT, LEGACY_SNAPSHOT_ID, parseLegacySnapshot } from './search/screening/legacy-snapshot.js'

export const MAX_RESEARCH_BYTES = 64 * 1024 * 1024
export const RESEARCH_FORMAT_V1 = LEGACY_SNAPSHOT_FORMAT
export const RESEARCH_FORMAT_V2 = 'search-boost-research-v2'
const ID = LEGACY_SNAPSHOT_ID
export const researchResultsDir = () => join(searchBoostHome(), 'state', 'research')
const fileFor = id => {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid saved research result ID')
  return join(researchResultsDir(), `${id}.json`)
}

// One source of truth for the stored metadata shapes. `strict: false` keeps Zod's
// strip-unknown-keys behaviour: a tampered extra field is scrubbed recursively and
// can never be exported, while a wrong value still fails the format check.
const v5MetadataSchema = jsonSchemaToZod(ADAPTIVE_V5_METADATA_SCHEMA, { strict: false })
const v5ResultRows = jsonSchemaToZod(ADAPTIVE_V5_OUTPUT_SCHEMA.properties.results, { strict: false })
const v2SnapshotSchema = z.object({
  format: z.literal(RESEARCH_FORMAT_V2),
  id: z.string().regex(ID),
  savedAt: z.string().datetime(),
  results: v5ResultRows,
  metadata: v5MetadataSchema,
})

function typedV2Snapshot(doc) {
  const parsed = v2SnapshotSchema.safeParse(doc)
  // No Zod issues/raw values in errors: saved files may contain sensitive input.
  if (!parsed.success) throw new Error('Saved research results are unreadable or invalid; no search was performed')
  return parsed.data
}
function typedLegacySnapshot(doc) {
  return parseLegacySnapshot(doc)
}
function checkDirectories() {
  for (const path of [join(searchBoostHome(),'state'),researchResultsDir()]) {
    let info
    try { info=lstatSync(path) } catch (err) { if(err.code==='ENOENT') continue; throw err }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Research store must use regular private directories')
  }
}

/** Write one schema-v5 run. Only an explicit save_results:true call reaches here. */
export function saveResearchResultsV2(results, metadata) {
  const id = randomUUID()
  const doc = typedV2Snapshot({ format: RESEARCH_FORMAT_V2, id, savedAt: new Date().toISOString(), results, metadata })
  const body = `${JSON.stringify(doc, null, 2)}\n`
  if (Buffer.byteLength(body) > MAX_RESEARCH_BYTES) throw new Error('Research snapshot exceeds the 64 MiB save limit')
  checkDirectories()
  writeFileAtomicPrivate(fileFor(id), body)
  return id
}

/** Read one private snapshot by verified format. Zero network, no re-execution. */
export function loadResearchResults(id) {
  const file=fileFor(id)
  let fd
  try {
    checkDirectories()
    const info=lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('invalid file')
    fd=openSync(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened=fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_RESEARCH_BYTES) throw new Error('invalid size/type')
    const chunks=[]; let size=0
    for (;;) {
      const chunk=Buffer.alloc(Math.min(64*1024,MAX_RESEARCH_BYTES-size+1))
      const count=readSync(fd,chunk,0,chunk.length,null)
      if(!count) break
      size+=count
      if(size>MAX_RESEARCH_BYTES) throw new Error('too large')
      chunks.push(chunk.subarray(0,count))
    }
    const raw=JSON.parse(Buffer.concat(chunks,size).toString('utf8'))
    // Format decides the validator: a v2 file that fails v5 validation is an
    // error, never silently re-read as v1.
    if (raw?.format === RESEARCH_FORMAT_V2) {
      const doc=typedV2Snapshot(raw)
      if(doc.id!==id) throw new Error('ID mismatch')
      return { format: doc.format, id: doc.id, savedAt: doc.savedAt, results: doc.results, metadata: doc.metadata }
    }
    if (raw?.format === RESEARCH_FORMAT_V1) {
      const doc=typedLegacySnapshot(raw)
      if(doc.id!==id) throw new Error('ID mismatch')
      return { format: doc.format, id: doc.id, savedAt: doc.savedAt, results: doc.results, metadata: doc.metadata }
    }
    throw new Error('unsupported format')
  } catch(err) {
    if(err.code==='ENOENT') throw new Error('Saved research results not found in this SearchBoost home; no search was performed')
    throw new Error('Saved research results are unreadable or invalid; no search was performed')
  } finally { if(fd!==undefined) closeSync(fd) }
}
export function listResearchResults() {
  checkDirectories()
  if (!existsSync(researchResultsDir())) return []
  return readdirSync(researchResultsDir()).filter(name => name.endsWith('.json') && ID.test(name.slice(0,-5))).sort().map(name => {
    const id=name.slice(0,-5)
    try {
      const doc=loadResearchResults(id)
      return { id,savedAt:doc.savedAt,totalResults:doc.results.length,question:doc.metadata.inputSummary?.question }
    } catch { return { id,unreadable:true } }
  })
}
export function exportResearchResults(id, output) {
  const doc=loadResearchResults(id)
  if (typeof output !== 'string' || !output.trim()) throw new Error('Supply an explicit --output file')
  // Explicit destination only; never overwrite a file or symlink.
  writeFileSync(resolve(output),`${JSON.stringify(doc,null,2)}\n`,{flag:'wx',mode:0o600})
  return resolve(output)
}
export function runResearchResultsCli(args) {
  if(args.length===1 && args[0]==='list') { console.log(JSON.stringify(listResearchResults(),null,2)); return }
  if(args.length===4 && args[0]==='export' && args[2]==='--output') {
    console.log(`Exported research results → ${exportResearchResults(args[1],args[3])}`); return
  }
  throw new Error('Usage: search-boost research list | research export <savedResultId> --output <new-file.json>')
}
