import './isolate-tests.mjs'
// Private research snapshots: v2/schema-v5 writes, frozen v1 read-only restores,
// pagination, CLI export, storage hardening and host boundaries. Offline only:
// the shared fused/Jev core is injected, the private store is the real one.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, truncateSync, symlinkSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { runAdaptiveSearch, clearAllCaches } from '../lib/runtime.mjs'
import {
  saveResearchResultsV2, loadResearchResults, listResearchResults, exportResearchResults,
  researchResultsDir, MAX_RESEARCH_BYTES, RESEARCH_FORMAT_V1, RESEARCH_FORMAT_V2,
} from '../lib/research-results.mjs'
import { normalizeAdaptiveInput } from '../lib/search/screening/input.js'
import { resultPages } from '../lib/search/screening/pages.js'
import { registerAll } from '../adapters/mcp/register.mjs'
import piExtension from '../adapters/pi/index.js'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../adapters/dsh/index.js'
import { saveJevConfig, clearJevConfig } from '../lib/jev-config.mjs'
import { saveToolPreferences } from '../lib/tool-config.mjs'
import { makeHarness } from './screening-run-fixture.mjs'

const secret='fixture-credential-not-to-persist'
// The public adaptive entry stays behind the tool switch and the Jev configuration
// lock, including cursor and saved_result_id reads. A fixture credential opens the
// gate without any network call; locking behaviour is asserted at the end.
saveJevConfig({apiKey:secret})
const store=researchResultsDir()
const LEGACY_ID='22222222-2222-4222-8222-222222222222'
const legacyRow=(id)=>({url:`https://legacy.example/${id}`,title:`Legacy ${id}`,description:`Stored v1 passage ${id}`,tier:'focus',valueScore:.8,directionMatch:1,kind:'lead'})
const legacyDoc=(id=LEGACY_ID)=>({
  format:RESEARCH_FORMAT_V1,id,savedAt:'2026-10-01T00:00:00.000Z',
  results:[legacyRow('a'),legacyRow('b')],
  metadata:{
    schemaVersion:3,retrievalSufficient:false,coverageComplete:false,stopReason:'keyword_queue_empty',
    warnings:['stored v1 warning'],inputSummary:{question:'Legacy fixture question',intent:'legacy intent',keywords:['scope'],constraints:['Only official sources'],constraintPolicy:'explicit_per_material'},
    scopeSummary:{eligible:1,rejected:1,unknown:0},
    keywordProgress:[{targetId:'q1',keyword:'scope',score:.9,distinctEvidence:1,finalStatus:'satisfied'}],
    privateLog:secret,inputSummaryExtra:secret,
  },
})
function writeLegacy(doc=legacyDoc()){
  mkdirSync(store,{recursive:true})
  const file=join(store,doc.id+'.json')
  writeFileSync(file,JSON.stringify(doc,null,2)+'\n')
  return file
}

// ---------------------------------------------------------------- v1 legacy ---
{
  const file=writeLegacy()
  const before=readFileSync(file,'utf8')
  const loaded=loadResearchResults(LEGACY_ID)
  assert.equal(loaded.format,RESEARCH_FORMAT_V1)
  assert.equal(loaded.metadata.schemaVersion,3)
  assert.equal(loaded.results.length,2)
  assert.deepEqual(loaded.metadata.inputSummary.constraints,['Only official sources'])
  assert(!JSON.stringify(loaded).includes(secret),'recursive legacy whitelist drops unknown credential/log fields')
  const originalFetch=globalThis.fetch
  let calls=0
  globalThis.fetch=async()=>{calls++;throw Error('unexpected request')}
  try{
    const restored=await runAdaptiveSearch({saved_result_id:LEGACY_ID,page_size:1})
    assert.deepEqual(restored.restoration,{historical:true,originalFormat:RESEARCH_FORMAT_V1,originalSchemaVersion:3})
    assert.equal(restored.schemaVersion,3,'a historical restore keeps the original schema version')
    assert.equal('selection' in restored,false)
    assert.equal('run' in restored,false)
    assert.equal('valueGroups' in restored,false)
    assert.equal(restored.totalResults,2)
    assert.equal(restored.results.length,1)
    assert.match(restored.nextCursor,/^h1:/)
    assert.match(restored.warnings.join(' '),/Historical snapshot restored read-only/)
    // page_size never re-caps or re-orders stored historical results
    const page2=await runAdaptiveSearch({cursor:restored.nextCursor,page_size:5})
    assert.equal(page2.results.length,1)
    assert.equal(page2.results[0].url,legacyRow('b').url)
    assert.deepEqual(page2.selection,undefined)
    assert.equal(readFileSync(file,'utf8'),before,'v1 files are read-only: restore never rewrites or upgrades them')
    clearAllCaches()
    const afterClear=await runAdaptiveSearch({saved_result_id:LEGACY_ID,page_size:2})
    assert.equal(afterClear.totalResults,2,'restore works after cache clear/restart')
    await assert.rejects(()=>runAdaptiveSearch({cursor:restored.nextCursor}),/expired or were evicted/)
  }finally{globalThis.fetch=originalFetch}
  assert.equal(calls,0,'historical restore performs zero network calls')
  // Missing original version stays missing: never guessed as v3 or v5.
  const noVersion=legacyDoc()
  delete noVersion.metadata.schemaVersion
  noVersion.id='33333333-3333-4333-8333-333333333333'
  writeLegacy(noVersion)
  const restoredNull=await runAdaptiveSearch({saved_result_id:noVersion.id})
  assert.equal(restoredNull.restoration.originalSchemaVersion,null)
  assert.equal('schemaVersion' in restoredNull,false)
  // The frozen v1 contract accepted a number, not only an integer. Preserve any
  // validated original value rather than quietly relabelling it as missing.
  const numbered=legacyDoc('66666666-6666-4666-8666-666666666666')
  numbered.metadata.schemaVersion=2.5
  const numberedFile=join(researchResultsDir(),`${numbered.id}.json`)
  writeFileSync(numberedFile,JSON.stringify(numbered))
  const numberedBefore=readFileSync(numberedFile,'utf8')
  const restoredNumber=await runAdaptiveSearch({saved_result_id:numbered.id})
  assert.equal(restoredNumber.schemaVersion,2.5)
  assert.equal(restoredNumber.restoration.originalSchemaVersion,2.5)
  assert.equal(readFileSync(numberedFile,'utf8'),numberedBefore)
}
console.log('ok: v1 snapshots restore read-only through h1 pages with original fields, zero network and no in-place upgrade')

// ------------------------------------------------------------- v2 write path ---
const v5Input={questions:['How does Node.js fetch support cancellation?'],intent:'Find traceable implementation references'}
let savedId
{
  const harness=makeHarness()
  const deps={...harness.deps,loadResults:loadResearchResults,saveResults:saveResearchResultsV2}
  const result=await runAdaptiveSearch({...v5Input,preferences:['Implementation details'],max_results:2,save_results:true,page_size:1},{},deps)
  savedId=result.savedResultId
  assert.equal(typeof savedId,'string')
  assert.equal(result.schemaVersion,5)
  const stored=JSON.parse(readFileSync(join(store,savedId+'.json'),'utf8'))
  assert.equal(stored.format,RESEARCH_FORMAT_V2)
  assert.equal(stored.metadata.schemaVersion,5)
  assert.equal(stored.results.length,2,'the complete selected set is stored, not only the first page')
  assert.equal(stored.metadata.run.community.outcome,'not_requested')
  assert.equal(stored.metadata.inputSummary.question,v5Input.questions[0])
  assert.equal('keywords' in stored.metadata.inputSummary,false)
  assert(!readFileSync(join(store,savedId+'.json'),'utf8').includes(secret),'no credential or private reasoning is persisted')
  // restore: same decision, no strategy/Jev/search/community/value call
  const restoreHarness=makeHarness()
  const reads={jev:0,search:0}
  const restoreDeps={...restoreHarness.deps,loadResults:loadResearchResults,saveResults:saveResearchResultsV2,
    createClient:()=>{reads.jev++;throw Error('no Jev client during restore')},search:()=>{reads.search++;throw Error('no search during restore')}}
  const restored=await runAdaptiveSearch({saved_result_id:savedId,page_size:1},{},restoreDeps)
  assert.equal(restored.schemaVersion,5)
  assert.equal(restored.policyVersion,'fused-screening-mix-v2-prototype')
  assert.equal(restored.run.community.outcome,'not_requested')
  assert.equal(restored.savedResultId,savedId)
  assert.equal(restored.totalResults,2)
  assert.equal(restored.results.length,1)
  assert.equal(restored.selection.targetMet,true)
  assert.match(restored.nextCursor,/^s5:/)
  assert.equal('restoration' in restored,false)
  assert.equal(reads.jev+reads.search,0)
  // CLI list/export stay offline and never overwrite
  const cli=(...args)=>spawnSync(process.execPath,[join(PKG_ROOT,'cli.mjs'),'research',...args],{env:process.env,encoding:'utf8',timeout:30000})
  const listed=JSON.parse(cli('list').stdout)
  assert(listed.some((entry)=>entry.id===savedId&&entry.totalResults===2))
  assert(listed.some((entry)=>entry.id===LEGACY_ID&&entry.totalResults===2&&!entry.unreadable),'CLI lists both formats')
  const output=join(process.env.HOME,'export.json')
  assert.equal(cli('export',savedId,'--output',output).status,0)
  assert.deepEqual(JSON.parse(readFileSync(output)),loadResearchResults(savedId))
  assert.equal(cli('export',savedId,'--output',output).status,1,'export refuses to overwrite')
  assert.equal(exportResearchResults(LEGACY_ID,join(process.env.HOME,'legacy-export.json')),join(process.env.HOME,'legacy-export.json'))
  assert.equal(JSON.parse(readFileSync(join(process.env.HOME,'legacy-export.json'))).format,RESEARCH_FORMAT_V1)
}
console.log('ok: explicit save writes search-boost-research-v2/schema-5 with the full selected set; restore and CLI list/export are offline')

// Legal maximum-length input must not fail after the private save. Page-only
// summaries may shrink, but every reviewed result and the saved input stay exact.
{
  for (const char of ['中', '\u0001', '😀']) {
    const repeated = limit => char.repeat(Math.floor(limit / char.length))
    const input = {
      questions: [repeated(400)], intent: repeated(2000),
      preferences: Array.from({ length: 8 }, (_, index) => repeated(298) + index),
      max_results: 4, page_size: 1, save_results: true, community: false,
    }
    const harness = makeHarness()
    const deps = { ...harness.deps, loadResults: loadResearchResults, saveResults: saveResearchResultsV2 }
    const before = readdirSync(store).length
    const result = await runAdaptiveSearch(input, {}, deps)
    assert.equal(typeof result.savedResultId, 'string', 'the private write always returns a recoverable ID')
    assert.equal(readdirSync(store).length, before + 1)
    const stored = loadResearchResults(result.savedResultId)
    assert.equal(stored.metadata.inputSummary.question, input.questions[0])
    assert.equal(stored.metadata.inputSummary.intent, input.intent)
    assert.deepEqual(stored.metadata.inputSummary.preferences, input.preferences)
    const reads = { jev: 0, search: 0 }
    const restoreDeps = { ...deps,
      createClient: () => { reads.jev++; throw Error('no Jev on restore') },
      search: () => { reads.search++; throw Error('no search on restore') },
    }
    const restored = await runAdaptiveSearch({ saved_result_id: result.savedResultId, page_size: 50 }, {}, restoreDeps)
    assert.deepEqual(restored.results, stored.results, 'restore keeps the complete reviewed set intact')
    assert.equal(reads.jev + reads.search, 0)
    assert.equal(restored.savedResultId, result.savedResultId)
    assert.deepEqual(restored.usage, result.usage)
    if (JSON.stringify(restored.inputSummary) !== JSON.stringify(stored.metadata.inputSummary)) {
      assert(restored.warnings.some(warning => /Input summary.*shortened/.test(warning)))
    }
    let page = result, rows = [...page.results]
    while (page.nextCursor) {
      page = await runAdaptiveSearch({ cursor: page.nextCursor, page_size: 1 }, {}, restoreDeps)
      rows.push(...page.results)
    }
    assert.deepEqual(rows, stored.results, 'paging never clips reviewed descriptions or loses rows')
    assert.equal(reads.jev + reads.search, 0)
    rmSync(join(store, result.savedResultId + '.json'))
  }
}
console.log('ok: legal maximum CJK/escaped/astral inputs return usable saved IDs, exact private snapshots and offline pages')

// ------------------------------------------------------- format dispatch -----
{
  const file=join(store,savedId+'.json')
  const good=readFileSync(file,'utf8')
  const broken=JSON.parse(good)
  broken.metadata.schemaVersion=4
  writeFileSync(file,JSON.stringify(broken))
  await assert.rejects(()=>runAdaptiveSearch({saved_result_id:savedId}),/invalid; no search/,'a bad v2 file is never downgraded to v1')
  broken.format='search-boost-research-v9'
  writeFileSync(file,JSON.stringify(broken))
  await assert.rejects(()=>runAdaptiveSearch({saved_result_id:savedId}),/invalid; no search/)
  writeFileSync(file,good)
  const raw=JSON.parse(good)
  raw.privateLog=secret
  raw.results[0].privateLog=secret
  raw.metadata.privateLog=secret
  raw.metadata.run.privateLog=secret
  writeFileSync(file,JSON.stringify(raw))
  assert(!JSON.stringify(loadResearchResults(savedId)).includes(secret),'tampered v2 fields are stripped recursively')
  const tampered=readFileSync(file,'utf8')
  writeFileSync(file,'')
  truncateSync(file,MAX_RESEARCH_BYTES+1)
  assert.throws(()=>loadResearchResults(savedId),/invalid; no search/)
  writeFileSync(file,tampered)
  const metadata=loadResearchResults(savedId).metadata
  const rows=loadResearchResults(savedId).results
  assert.throws(()=>saveResearchResultsV2([{...rows[0],description:'x'.repeat(MAX_RESEARCH_BYTES)}],metadata),/64 MiB/)
  if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600)
  rmSync(file)
  await assert.rejects(()=>runAdaptiveSearch({saved_result_id:savedId}),/not found.*no search/)
  const target=join(process.env.HOME,'outside.json')
  writeFileSync(target,JSON.stringify(loadResearchResults(LEGACY_ID)&&{format:RESEARCH_FORMAT_V2}))
  let links=true
  try{symlinkSync(target,file)}catch(err){if(process.platform!=='win32'||!['EPERM','EACCES','ENOSYS'].includes(err.code))throw err;links=false}
  if(links){assert.throws(()=>loadResearchResults(savedId),/invalid/);rmSync(file)}
  linkSync(target,file)
  assert.throws(()=>loadResearchResults(savedId),/invalid/,'hard links are refused')
  rmSync(file)
  if(links){
    const held=researchResultsDir();rmSync(held,{recursive:true});symlinkSync(process.env.HOME,held,process.platform==='win32'?'junction':'dir')
    assert.throws(()=>saveResearchResultsV2(rows,metadata),/regular private directories/)
    rmSync(held)
  }
  mkdirSync(store,{recursive:true})
  // Restore the untampered snapshots for the host-boundary checks below.
  writeFileSync(file,good)
  writeLegacy()
}
console.log('ok: unsupported/oversize/linked/aliased snapshots fail closed and never fall back to another format')

// --------------------------------------------------- input contract guards ---
{
  assert.throws(()=>normalizeAdaptiveInput({saved_result_id:'../'+LEGACY_ID}),/Invalid saved research result ID/)
  for(const input of [{saved_result_id:LEGACY_ID,questions:['x']},{cursor:'s5:x.0',saved_result_id:LEGACY_ID},{saved_result_id:LEGACY_ID,save_results:false},{cursor:'s5:x.0',save_results:true},{saved_result_id:LEGACY_ID,constraints:[]},{saved_result_id:LEGACY_ID,community:false}]){
    assert.throws(()=>normalizeAdaptiveInput(input),/cannot be combined|accepts page_size only/)
  }
}

// --------------------------------------------------------- host boundaries ---
{
  const originalFetch=globalThis.fetch
  let calls=0
  globalThis.fetch=async()=>{calls++;throw Error('unexpected request')}
  try{
    const handlers=new Map(),definitions=new Map()
    const stop=registerAll({registerTool:(name,def,handler)=>{handlers.set(name,handler);definitions.set(name,def)},registerResource(){},registerPrompt(){}})
    assert.equal(definitions.get('adaptive_search').annotations.readOnlyHint,false,'optional save must not claim a read-only MCP tool')
    const mcp=await handlers.get('adaptive_search')({saved_result_id:savedId,page_size:1},{signal:new AbortController().signal})
    assert(!mcp.isError)
    assert.equal(mcp.structuredContent.savedResultId,savedId)
    const mcpLegacy=await handlers.get('adaptive_search')({saved_result_id:LEGACY_ID,page_size:1},{signal:new AbortController().signal})
    assert(!mcpLegacy.isError,'reading an old snapshot that originally failed must be a successful read')
    assert.equal(mcpLegacy.structuredContent.restoration.historical,true)
    assert(!JSON.stringify(mcpLegacy.structuredContent).includes('Jev is not configured'))
    stop()
    const piTools=new Map();piExtension({registerTool:t=>piTools.set(t.name,t),registerCommand(){},on(){}})
    const pi=await piTools.get('adaptive_search').execute('id',{saved_result_id:LEGACY_ID},new AbortController().signal)
    assert.equal(pi.details.restoration.historical,true)
    assert.equal(pi.details.totalResults,2)
    assert(pi.content[0].text.includes('historical'))
    const dshTools=new Map()
    const dshCtx=new Context()
    dshCtx.provide('systemPrompt');dshCtx.set('systemPrompt',{tools(){},section(){}})
    dshCtx.provide('web');dshCtx.set('web',{registerSearchProvider(){},registerFetchProvider(){}})
    dshCtx.provide('commands');dshCtx.set('commands',{register(){}})
    dshCtx.provide('tools');dshCtx.set('tools',{register:t=>dshTools.set(t.name,t)})
    apply(dshCtx)
    const dsh=await dshTools.get('adaptive_search').execute({saved_result_id:LEGACY_ID},null)
    assert.equal(dsh.restoration.originalSchemaVersion,3)
    assert.equal(dsh.totalResults,2)
    assert(dshTools.get('adaptive_search').output.render({},dsh)[0].text.includes('historical'))
    const before=calls
    saveToolPreferences({adaptive_search:false})
    await assert.rejects(()=>piTools.get('adaptive_search').execute('id',{saved_result_id:LEGACY_ID}),/Disabled by user/)
    await assert.rejects(()=>dshTools.get('adaptive_search').execute({saved_result_id:LEGACY_ID},{signal:null}),/Disabled by user/)
    await assert.rejects(()=>runAdaptiveSearch({saved_result_id:LEGACY_ID}),/Disabled by user/,'the core entry gate also refuses reads while the tool is OFF')
    assert.equal(calls,before)
    saveToolPreferences({adaptive_search:true})
    // The Jev configuration lock also closes local reads; it is not bypassed by a
    // saved_result_id. CLI list/export stay offline in that state.
    clearJevConfig()
    await assert.rejects(()=>piTools.get('adaptive_search').execute('id',{saved_result_id:LEGACY_ID},new AbortController().signal),/Je[Dd]v not configured|Jev/)
    assert.equal(JSON.parse(spawnSync(process.execPath,[join(PKG_ROOT,'cli.mjs'),'research','list'],{env:process.env,encoding:'utf8',timeout:30000}).stdout).length>0,true)
    saveJevConfig({apiKey:secret})
  }finally{globalThis.fetch=originalFetch}
}
console.log('ok: MCP/Pi/DSH restore both formats without network; historical reads are not reported as this call\'s failure; explicit OFF still blocks')

// ------------------------------------------------------------- empty save ----
{
  const harness=makeHarness({rows:[]})
  const deps={...harness.deps,loadResults:loadResearchResults,saveResults:saveResearchResultsV2}
  const empty=await runAdaptiveSearch({...v5Input,max_results:1,save_results:true},{},deps)
  assert.equal(typeof empty.savedResultId,'string','an explicitly empty reviewed set may be saved')
  assert(empty.warnings.some((warning)=>warning.includes('snapshot is empty')))
  assert.equal(empty.nextCursor,null)
  assert.equal(empty.totalResults,0)
  assert.equal(empty.pageResults,0)
  assert.equal(empty.selection.returned,0)
  assert.equal(loadResearchResults(empty.savedResultId).results.length,0)
  const reread=await runAdaptiveSearch({saved_result_id:empty.savedResultId},{},deps)
  assert.equal(reread.totalResults,0)
  assert.equal(reread.stopReason,empty.stopReason)
}
console.log('ok: an explicitly empty reviewed snapshot can be saved and still warns that a saved ID is not search success')
console.log('research persistence: v2 write, v1/v2 restore, dual-format CLI export, storage hardening and host boundaries PASS')
clearJevConfig()
