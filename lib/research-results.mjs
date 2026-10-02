/** Opt-in private snapshots: public materials + typed response metadata, not live cursors or model logs. */
import { randomUUID } from 'node:crypto'
import { constants, existsSync, readdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as z from 'zod'
import { searchBoostHome } from './config-paths.mjs'
import { writeFileAtomicPrivate } from './private-file.mjs'
import { adaptiveSearchOutput } from './search/adaptive/output.js'

export const MAX_RESEARCH_BYTES = 64 * 1024 * 1024
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const researchResultsDir = () => join(searchBoostHome(), 'state', 'research')
const fileFor = id => {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid saved research result ID')
  return join(researchResultsDir(), `${id}.json`)
}
const metadataShape = { ...adaptiveSearchOutput }
for (const key of ['results','totalResults','nextCursor','expiresAt','savedResultId']) delete metadataShape[key]
metadataShape.inputSummary = adaptiveSearchOutput.inputSummary.unwrap()
const metadataSchema = z.object(metadataShape).refine(value => value.schemaVersion !== 3 || value.coverageComplete === false)
const snapshotSchema = z.object({
  format: z.literal('search-boost-research-v1'), id: z.string().regex(ID), savedAt: z.string().datetime(),
  results: adaptiveSearchOutput.results, metadata: metadataSchema,
})

function typedSnapshot(doc) {
  const parsed = snapshotSchema.safeParse(doc)
  // No Zod issues/raw values in errors: saved files may contain sensitive input.
  if (!parsed.success) throw new Error('Saved research results are unreadable or invalid; no search was performed')
  return parsed.data // recursive public-schema stripping excludes unknown fields
}
function checkDirectories() {
  for (const path of [join(searchBoostHome(),'state'),researchResultsDir()]) {
    let info
    try { info=lstatSync(path) } catch (err) { if(err.code==='ENOENT') continue; throw err }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Research store must use regular private directories')
  }
}
export function saveResearchResults(results, metadata) {
  const id = randomUUID()
  const doc = typedSnapshot({ format:'search-boost-research-v1',id,savedAt:new Date().toISOString(),results,metadata })
  const body = `${JSON.stringify(doc, null, 2)}\n`
  if (Buffer.byteLength(body) > MAX_RESEARCH_BYTES) throw new Error('Research snapshot exceeds the 64 MiB save limit')
  checkDirectories()
  writeFileAtomicPrivate(fileFor(id), body)
  return id
}
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
    const doc=typedSnapshot(JSON.parse(Buffer.concat(chunks,size).toString('utf8')))
    if(doc.id!==id) throw new Error('ID mismatch')
    return doc
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
      return { id,savedAt:doc.savedAt,totalResults:doc.results.length,question:doc.metadata.inputSummary.question }
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
