import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync,truncateSync,symlinkSync,linkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { runAdaptiveSearch,clearAllCaches } from '../lib/runtime.mjs'
import { approvedResults,validatePageInput } from '../lib/search/adaptive/pages.js'
import { saveResearchResults,loadResearchResults,listResearchResults,exportResearchResults,researchResultsDir,MAX_RESEARCH_BYTES } from '../lib/research-results.mjs'
import { adaptiveSearchInput,adaptiveSearchOutput } from '../adapters/mcp/schemas.mjs'
import { registerAll } from '../adapters/mcp/register.mjs'
import piExtension from '../adapters/pi/index.js'
import { apply } from '../adapters/dsh/index.js'
import { saveJevConfig,clearJevConfig } from '../lib/jev-config.mjs'
import { saveToolPreferences } from '../lib/tool-config.mjs'
const secret='fixture-credential-not-to-persist'
const metadata={schemaVersion:3,retrievalSufficient:false,coverageComplete:false,stopReason:'keyword_queue_empty',warnings:[],inputSummary:{question:'Fixture question',intent:'fixture inspection',keywords:['scope'],constraints:['Only official sources'],constraintPolicy:'explicit_per_material',internalSecret:secret},privateLog:secret}
const evidence=(id,extra={})=>({url:`https://example.com/${id}`,title:`Official ${id}`,reviewedText:'Public approved passage '+id,status:'useful_result',assessed:true,admissionPolicy:'explicit-constraints-v2',admitted:true,scope:{route:'eligible'},valueScore:.8,judgment:{direction_match:1},kind:'lead',...extra})
const rows=approvedResults([evidence('a'),evidence('b'),evidence('a'),evidence('rejected',{admitted:false}),evidence('pending',{assessed:false})])
assert.equal(rows.length,2)
const id=saveResearchResults(rows.map(row=>({...row,privateLog:secret})),metadata)
const file=join(researchResultsDir(),id+'.json')
assert(!readFileSync(file,'utf8').includes(secret),'recursive public-schema stripping excludes unknown credential/model-log fields')
if(process.platform!=='win32'){assert.equal(statSync(file).mode&0o777,0o600);assert.equal(statSync(researchResultsDir()).mode&0o777,0o700)}
const restored=await runAdaptiveSearch({saved_result_id:id,page_size:1})
assert.equal(restored.results.length,1);assert.equal(restored.totalResults,2);assert.equal(restored.savedResultId,id)
assert.deepEqual(restored.inputSummary.constraints,['Only official sources'])
assert.equal(z.object(adaptiveSearchOutput).strict().parse(restored).savedResultId,id)
clearAllCaches()
const again=await runAdaptiveSearch({saved_result_id:id,page_size:1})
const next=await runAdaptiveSearch({cursor:again.nextCursor})
assert.equal(next.results[0].url,rows[1].url)
assert.equal(next.savedResultId,id)
const child=spawnSync(process.execPath,['--input-type=module','-e',`const {runAdaptiveSearch}=await import(${JSON.stringify(pathToFileURL(join(PKG_ROOT,'lib/runtime.mjs')).href)});globalThis.fetch=()=>{throw Error('NO NETWORK')};console.log(JSON.stringify(await runAdaptiveSearch({saved_result_id:${JSON.stringify(id)}})));`],{env:process.env,encoding:'utf8',timeout:30000})
assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).totalResults,2)
const cli=(...args)=>spawnSync(process.execPath,[join(PKG_ROOT,'cli.mjs'),'research',...args],{env:process.env,encoding:'utf8',timeout:30000})
assert.equal(JSON.parse(cli('list').stdout)[0].id,id)
const output=join(process.env.HOME,'export.json')
assert.equal(cli('export',id,'--output',output).status,0)
assert.deepEqual(JSON.parse(readFileSync(output)),loadResearchResults(id))
assert.equal(cli('export',id,'--output',output).status,1)
assert(!readFileSync(output,'utf8').includes(secret))
assert.throws(()=>validatePageInput({saved_result_id:'../'+id}),/Invalid/)
for(const input of [{saved_result_id:id,questions:['x']},{cursor:'c',saved_result_id:id},{saved_result_id:id,save_results:false},{cursor:'c',save_results:true}])assert.throws(()=>validatePageInput(input),/cannot be combined/)
assert.throws(()=>z.object(adaptiveSearchInput).parse({saved_result_id:'x'.repeat(36)}))
const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected request')}
try{
 saveJevConfig({apiKey:secret}) // host credential lock remains; restoration sends no request
 const handlers=new Map(),definitions=new Map()
 const stop=registerAll({registerTool:(name,def,handler)=>{handlers.set(name,handler);definitions.set(name,def)},registerResource(){},registerPrompt(){}})
 assert.equal(definitions.get('adaptive_search').annotations.readOnlyHint,false,'optional save must not claim a read-only MCP tool')
 const mcp=await handlers.get('adaptive_search')({saved_result_id:id,page_size:1},{signal:new AbortController().signal})
 assert(!mcp.isError);assert.equal(mcp.structuredContent.savedResultId,id);assert.equal(mcp.structuredContent.results.length,1)
 assert(mcp.content[0].text.includes(id));stop()
 const piTools=new Map();piExtension({registerTool:t=>piTools.set(t.name,t),registerCommand(){},on(){}})
 const pi=await piTools.get('adaptive_search').execute('id',{saved_result_id:id},new AbortController().signal)
 assert.equal(pi.details.totalResults,2);assert(pi.content[0].text.includes(id))
 const dshTools=new Map();apply({get:n=>n==='commands'?{register(){}}:undefined,tools:{register:t=>dshTools.set(t.name,t)},web:{registerSearchProvider(){},registerFetchProvider(){}},systemPrompt:{section(){}}})
 const dsh=await dshTools.get('adaptive_search').execute({saved_result_id:id},{})
 assert.equal(dsh.savedResultId,id);assert.equal(dsh.totalResults,2)
 saveToolPreferences({adaptive_search:false})
 await assert.rejects(()=>piTools.get('adaptive_search').execute('id',{saved_result_id:id}),/Disabled by user/)
 await assert.rejects(()=>dshTools.get('adaptive_search').execute({saved_result_id:id},{}),/Disabled by user/)
 assert.equal(calls,0)
 saveToolPreferences({adaptive_search:true});clearJevConfig()
}finally{globalThis.fetch=originalFetch}
console.log('ok: selected-only snapshots, restart/cache-clear pagination, public MCP/Pi/DSH restore, typed fields, secret/log stripping, host switches and explicit no-overwrite export')

const raw=JSON.parse(readFileSync(file,'utf8'))
raw.privateLog=secret;raw.results[0].privateLog=secret;raw.metadata.inputSummary.privateLog=secret
writeFileSync(file,JSON.stringify(raw))
assert(!JSON.stringify(loadResearchResults(id)).includes(secret),'tampered unknown fields cannot be exported')
raw.metadata.inputSummary.constraints=42;writeFileSync(file,JSON.stringify(raw))
await assert.rejects(()=>runAdaptiveSearch({saved_result_id:id}),/invalid; no search/)
assert.equal(listResearchResults()[0].unreadable,true)
writeFileSync(file,'');truncateSync(file,MAX_RESEARCH_BYTES+1)
assert.throws(()=>loadResearchResults(id),/invalid; no search/)
rmSync(file)
await assert.rejects(()=>runAdaptiveSearch({saved_result_id:id}),/not found.*no search/)
assert.throws(()=>saveResearchResults([{url:'u',title:'t',description:'x'.repeat(MAX_RESEARCH_BYTES)}],metadata),/64 MiB/)
assert.equal(readdirSync(researchResultsDir()).length,0,'failed save cannot leave partial snapshots')
const target=join(process.env.HOME,'outside.json');writeFileSync(target,JSON.stringify({...raw,metadata}))
let links=true;try{symlinkSync(target,file)}catch(err){if(process.platform!=='win32'||!['EPERM','EACCES','ENOSYS'].includes(err.code))throw err;links=false;console.log('skip: Windows symlink privilege unavailable')}
if(links){assert.throws(()=>loadResearchResults(id),/invalid/);rmSync(file)}
linkSync(target,file);assert.throws(()=>loadResearchResults(id),/invalid/);rmSync(file)
if(links){
 const store=researchResultsDir();rmSync(store,{recursive:true});symlinkSync(process.env.HOME,store,process.platform==='win32'?'junction':'dir')
 assert.throws(()=>saveResearchResults(rows,metadata),/regular private directories/);rmSync(store)
}
const fresh=await runAdaptiveSearch({questions:['Original request'],constraints:['Only official sources'],save_results:false})
assert(!fresh.savedResultId)
const saved=await runAdaptiveSearch({questions:['Original request'],constraints:['Only official sources'],save_results:true})
assert(saved.savedResultId);assert.equal(saved.inputSummary.constraintPolicy,'explicit_per_material')
assert(saved.warnings.some(w=>w.includes('snapshot is empty')))
assert(loadResearchResults(saved.savedResultId).metadata.warnings.some(w=>w.includes('snapshot is empty')))
const store=researchResultsDir();rmSync(store,{recursive:true});writeFileSync(store,'unwritable directory fixture')
const failed=await runAdaptiveSearch({questions:['Original request'],save_results:true})
assert(!failed.savedResultId);assert(Array.isArray(failed.results));assert(failed.warnings.some(w=>w.includes('NOT saved')))
const abort=new AbortController();abort.abort()
await assert.rejects(()=>runAdaptiveSearch({questions:['q'],save_results:true},{signal:abort.signal}),/abort/i)
console.log('ok: malformed/missing/oversize snapshots and file/directory aliases fail closed; opt-in/failed save/cancel never trigger another search or destroy returned pages')
