#!/usr/bin/env node
// HISTORICAL COMPARISON: hermetic V2 keyword/fact controller checks, frozen with
// retrievalMode:false. These are NOT web-quality experiments and NOT evidence
// that the default V3 reading-value controller works (see test-retrieval*.mjs).
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {runAdaptiveLoop} from '../lib/search/adaptive/loop.mjs'
import {ADAPTIVE_LIMITS,ADAPTIVE_THRESHOLDS} from '../lib/search/adaptive/limits.js'
import {scoreEvidence,nextPoolLimit} from '../lib/search/adaptive/keyword-progress.js'
import {approvedResults,createResultPages} from '../lib/search/adaptive/pages.js'
import {selectEngineCandidates} from '../lib/search/adaptive/planning.js'
import {fusedSearch} from '../lib/search/fusion.js'
const engines=['bing','ddg','yahoo','exa-free','anysearch']
const randomText=i=>Array.from({length:14},(_,j)=>createHash('sha256').update(`${i}/${j}`).digest('hex').slice(0,10)).join(' ')
const hit=i=>({url:`https://source${i}.example.net/article`,title:`Evidence ${i}`,snippet:randomText(i),score:1,engines:['bing']})
const input={tasks:[{context:'Testing evidence',targets:[{id:'target',keywords:['alpha'],question:'What happens to alpha?'}]}]}
function harness({search,source,coverage,bundle,limits={},thresholds,fail,signal}={}){
 const calls={search:[],jev:[]};let count=0
 // HISTORICAL COMPARISON ONLY: retrievalMode:false freezes the V2 keyword/fact
 // controller. It is not evidence that the default V3 reading-value mode works;
 // scripts/test-retrieval*.mjs covers the default mode.
 const deps={limits:{...ADAPTIVE_LIMITS,retrievalMode:false,...limits},thresholds:{...ADAPTIVE_THRESHOLDS,...thresholds},signal,onComplete:({evidence})=>{calls.evidence=evidence},
 snapshot:()=>({capability:{defaultEnginePool:'free',pools:{free:engines},availableEngines:engines}}),
 runFused:async args=>{calls.search.push(args);return {results:await (search?.(args,calls.search.length)??[hit(1)]),enginesUsed:args.engineList,engineStats:Object.fromEntries(args.engineList.map(e=>[e,{used:true,attempts:1,successes:1,errors:0}]))}},
 runFetchPage:async()=>({content:'',word_count:0}),
 jev:{usage:()=>({calls:count,httpAttempts:count,inputTokens:0}),ask:async({phase,state,questions})=>{
  count++;calls.jev.push({phase,state,questions});if(fail?.(phase,count))throw new Error('injected failure')
  const entries=new Map()
  for(const [id,spec] of Object.entries(questions)){
   let value
   if(phase==='source_judge')value=source?source(id,state): /injection|premise_conflict/.test(id)? .02:id.endsWith('.stance')?'support':.94
   else if(phase==='fact_bundle')value=bundle?bundle(id,state):id.endsWith('.stance')?'support':.94
   else if(phase==='coverage_judge')value=coverage?coverage(id,state):id.endsWith('.gap')?'none':id.endsWith('.source_conflict')?.02:.90
   else value=spec.type==='noul'?.9:Object.keys(spec.criteria)[0]
   if(phase==='source_judge' && id.endsWith('.stance') && typeof value==='number')value='support'
   if(value===undefined)continue
   entries.set(id,spec.type==='noul'?{type:'noul',value}:{type:'choice',choice:value,confidence:.9})
  }
  return {entries,model:'hermetic',usage:{inputTokens:0},attempts:1,requestChars:JSON.stringify({state,questions}).length}
 }}}
 return {calls,run:(arg=input)=>runAdaptiveLoop(arg,deps)}
}
let passed=0
async function test(name,fn){try{await fn();passed++;console.log('ok',name)}catch(e){console.error('FAIL',name,e);process.exitCode=1}}
await test('quota proportion, floor, ceiling and no search at zero',()=>{
 assert.equal(nextPoolLimit(4,4),500);assert.equal(nextPoolLimit(1,4),157);assert.equal(nextPoolLimit(1,48),24);assert.equal(nextPoolLimit(0,4),0)
 assert.throws(()=>nextPoolLimit(5,4))
})
await test('first evidence can release; cloned evidence never adds; absent facts stay unknown',()=>{
 const row={evidenceId:'one',text:randomText(1),url:'https://one.test/a',judgment:{relevant:.9,states_evidence:.9,injection:.05,sufficient:.9}}
 row.facts=[{factId:'f1',support:.94,stance:'support',independent:.95}];
 const options={facts:[{id:'f1',weight:1}]};
 const one=scoreEvidence([row],options);assert.ok(one.ready)
 const clones=Array.from({length:500},(_,i)=>({...row,evidenceId:`e${i}`,url:`https://copy${i}.test/a`}))
 assert.equal(scoreEvidence(clones,options).score,one.score)
 assert.equal(scoreEvidence([{...row,facts:[]}],options).F,0)
 assert.equal(scoreEvidence([{...row,judgment:{...row.judgment,injection:.99}}]).score,0)
})
await test('500 distinct candidates drain under production budgets; all 5 engines offered; all approved paginate',async()=>{
 const h=harness({search:()=>Array.from({length:500},(_,i)=>hit(i))})
 const r=await h.run();assert.equal(r.evidence.sources,500);assert.equal(r.funnel.pending_associations,0)
 assert.equal(r.questions[0].status,'covered');assert.equal(r.rounds,1)
 assert.equal(h.calls.search[0].engineList.length,5);assert.equal(h.calls.search[0].maxResults,500)
 assert.equal(r.funnel.reviewed_associations,500)
 assert.ok(JSON.stringify(r).length<=ADAPTIVE_LIMITS.maxOutputChars)
 assert.equal(approvedResults(h.calls.evidence).length,500)
 console.log('500 metrics',JSON.stringify({calls:r.usage.jevCalls,tokens:r.usage.jevInputTokensEstimated,ms:r.usage.tookMs}))
})
await test('global pool is 500, not 500 per target; cross-target assignment',async()=>{
 const h=harness({search:(args,n)=>Array.from({length:args.maxResults},(_,i)=>hit(i+(n-1)*250))})
 const r=await h.run({tasks:[{context:'Testing evidence',targets:[{id:'a',keywords:['alpha'],question:'Explain alpha'},{id:'b',keywords:['beta'],question:'Explain beta'}]}]})
 assert.equal(r.evidence.sources,500);assert.equal(h.calls.search.slice(0,2).reduce((n,a)=>n+a.maxResults,0),500)
 assert.equal(r.questions[0].evidenceCount,500);assert.equal(r.questions[1].evidenceCount,500)
 // Budget may leave pending associations in multi-target mode; never assert coverage without final check.
 if(r.questions.some(q=>q.status==='covered'))assert.ok(h.calls.jev.some(c=>c.phase==='coverage_judge'))
})
await test('next round follows one remaining keyword out of four; no action-planning call',async()=>{
 const h=harness({limits:{maxRounds:2},search:(a,n)=>[hit(n)],source:(id,state)=>{
  if(/injection|premise_conflict/.test(id))return .02
  if(id.includes('.kw3.'))return .1
  return .94
 }})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha','beta','gamma','delta'],question:'Explain the four items'}]}]})
 assert.equal(r.roundLog[1].poolLimit,157);assert.equal(h.calls.search[1].maxResults,157)
 assert.equal(h.calls.jev.filter(x=>x.phase==='plan').length,1)
 assert.equal(h.calls.jev.filter(x=>x.phase==='coverage_judge').length,0)
 assert.equal(r.questions[0].keywordProgress.filter(k=>k.ready).length,3)
 assert.notEqual(r.questions[0].status,'covered')
})
await test('global final check waits for all targets, not only one target',async()=>{
 const h=harness({limits:{maxRounds:1},source:(id,state)=>/injection|premise_conflict/.test(id)?.02:state.candidates.find(c=>c.id===id.split('.')[1]).for_question==='q1'?.94:.1})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'Alpha?'},{id:'b',keywords:['beta'],question:'Beta?'}]}]})
 assert.equal(h.calls.jev.filter(x=>x.phase==='coverage_judge').length,0);assert.ok(r.questions.every(q=>q.status!=='covered'))
})
await test('unknown judgment and cancellation never auto-complete',async()=>{
 const h=harness({source:id=>id.endsWith('.injection')?undefined:.95,limits:{maxRounds:1}})
 assert.notEqual((await h.run()).questions[0].status,'covered')
 const ctl=new AbortController();ctl.abort();const c=harness({signal:ctl.signal})
 assert.equal((await c.run()).stopReason,'cancelled');assert.equal(c.calls.search.length,0)
})
await test('concrete final gap reopens searches but at most two final checks',async()=>{
 const h=harness({search:(a,n)=>[hit(n)],coverage:id=>id.endsWith('.gap')?'fact':id.endsWith('.coverage')?.3:id.endsWith('.source_conflict')?.02:.9})
 const r=await h.run();assert.notEqual(r.questions[0].status,'covered')
 assert.equal(h.calls.jev.filter(x=>x.phase==='coverage_judge').length,2)
 assert.equal(r.questions[0].finalChecks,2);assert.equal(h.calls.search.length,2)
})
await test('repeated search does not increase score and no-progress stops honestly',async()=>{
 const h=harness({source:id=>/injection|premise_conflict/.test(id)?.02:id.endsWith('.sufficient')?.05:.61})
 const r=await h.run();assert.notEqual(r.questions[0].status,'covered')
 assert.ok(r.rounds<=4);const scores=r.roundLog.map(x=>x.keywordProgress?.[0]?.score).filter(x=>x!=null)
 assert.ok(scores.every(s=>s===scores[0]))
})
await test('public fusion still caps20, private collection allows500 without fake results',async()=>{
 const runOne=async()=>Array.from({length:500},(_,i)=>({...hit(i),content:randomText(i)}))
 const common={query:'alpha evidence',engines:['bing'],maxResults:500,maxResultsCap:500,tier:'simple',runOne,finalize:false}
 const publicResult=await fusedSearch({...common,finalize:true})
 assert.ok(publicResult.results.length<=20)
 const privateResult=await fusedSearch({...common,candidateMode:true})
 // finalize:false exposes upstream pool intentionally; verify provider requested counts instead below.
 assert.ok(privateResult.results.length>=publicResult.results.length)
 let requested=[]
 await fusedSearch({...common,runOne:async(e,q,n)=>{requested.push(n);return []}})
 const publicN=requested[0];requested=[]
 await fusedSearch({...common,candidateMode:true,runOne:async(e,q,n)=>{requested.push(n);return []}})
 assert.ok(requested[0]>=publicN)
})
/** Safety invariants for the default fact-aware path (not the frozen V1 suite). */
await test('missing acceptance facts cannot earn readiness by accumulating incomplete fragments',async()=>{
 const h=harness({bundle:id=>id.endsWith('.stance')?'unknown':.1,limits:{maxRounds:1},search:()=>[1,2,3].map(i=>({...hit(i),url:`https://independent${i}.test/page`})),source:id=>/injection|premise_conflict/.test(id)?.02:id.endsWith('.support')?0:.9,
 coverage:id=>id.endsWith('.gap')?'fact':id.endsWith('.coverage')?.2:id.endsWith('.source_conflict')?.02:.9})
 const r=await h.run();assert.equal(r.questions[0].keywordProgress[0].ready,false)
 assert.equal(h.calls.jev.filter(c=>c.phase==='coverage_judge').length,0)
 assert.notEqual(r.questions[0].status,'covered')
})
await test('insufficient call budget preserves all pending and cannot fabricate coverage',async()=>{
 const h=harness({search:()=>Array.from({length:500},(_,i)=>hit(i)),limits:{maxJevCalls:2}})
 const r=await h.run();assert.equal(r.evidence.sources,500);assert.ok(r.funnel.pending_associations>0)
 assert.equal(r.usage.jevCalls,2);assert.notEqual(r.questions[0].status,'covered')
})
await test('updated text revokes old keyword scores and prior final evidence',async()=>{
 const h=harness({limits:{maxRounds:2},search:(a,n)=>[{...hit(1),content:randomText(1)+(n===1?'':' altered untrusted new material here')}],
 source:(id,state)=>{
  const ref=state.candidates.find(c=>c.id===id.split('.')[1]);const text=state.sources[ref.source_index].fragments[ref.fragment_index].text
  return id.endsWith('.injection')?(text.includes('altered')?.99:.02):id.endsWith('.premise_conflict')?.02:.94
 },coverage:id=>id.endsWith('.gap')?'fact':id.endsWith('.coverage')?.2:id.endsWith('.source_conflict')?.02:.9})
 const r=await h.run();assert.equal(r.questions[0].keywordProgress[0].score,0);assert.notEqual(r.questions[0].status,'covered')
})
await test('missing conflict verdict blocks completion even when every keyword is ready',async()=>{
 const h=harness({limits:{maxRounds:1},search:()=>[hit(1),hit(2)],coverage:id=>id.endsWith('.gap')?'none':id.endsWith('.source_conflict')?undefined:.95})
 const r=await h.run();assert.ok(r.questions[0].keywordProgress[0].ready);assert.notEqual(r.questions[0].status,'covered')
})
await test('premise refutation remains usable; explicit missing dates cannot qualify',async()=>{
 const h=harness({source:id=>id.endsWith('.injection')?.02:.94})
 assert.equal((await h.run()).questions[0].status,'covered')
 const dated=harness({limits:{maxRounds:1}})
 const r=await dated.run({tasks:[{context:'Testing evidence',time_range:{start:'2026-01-01',end:'2026-01-01',basis:'event'},targets:[{id:'a',keywords:['alpha'],question:'What happened?'}]}]})
 assert.equal(r.questions[0].keywordProgress[0].score,0);assert.notEqual(r.questions[0].status,'covered')
})
await test('metadata is preserved and cloned on pagination; private selection does not recut at20',()=>{
 const pages=createResultPages();const metadata={coverageComplete:false,stopReason:'budget_calls',warnings:[],keywordProgress:[{keyword:'alpha',score:.5}],pendingAssessments:40}
 const page=pages.save(Array.from({length:55},(_,i)=>({url:`https://p.test/${i}`,title:'t',description:'d'})),metadata,20)
 assert.equal(page.totalResults,55);assert.equal(page.pendingAssessments,40);page.keywordProgress[0].score=10
 assert.equal(pages.read(page.nextCursor,20).keywordProgress[0].score,.5)
 assert.equal(selectEngineCandidates(Array.from({length:500},(_,i)=>hit(i)),['bing'],500).results.length,500)
})

await test('two partial fragments need a real union judgment, then still a final check',async()=>{
 const h=harness({limits:{maxRounds:1},search:()=>[hit(1),hit(2)],
  source:id=>/injection|premise_conflict/.test(id)?.02:id.endsWith('.support')?.2:.94,
  bundle:id=>id.endsWith('.stance')?'support':.95})
 const r=await h.run();assert.equal(r.questions[0].status,'covered')
 assert.equal(h.calls.jev.filter(c=>c.phase==='fact_bundle').length,1)
 assert.equal(h.calls.jev.filter(c=>c.phase==='coverage_judge').length,1)
 assert.equal(r.questions[0].keywordProgress[0].R,0)
 const final=h.calls.jev.find(c=>c.phase==='coverage_judge')
 assert.equal(final.state.evidence.length,2)
})
await test('known final gap and missing gap judgment veto optimistic coverage',async()=>{
 for(const gap of ['fact',undefined]){
  const h=harness({limits:{maxRounds:1},coverage:id=>id.endsWith('.gap')?gap:id.endsWith('.source_conflict')?.02:.99})
  const r=await h.run();assert.notEqual(r.questions[0].status,'covered')
 }
})
await test('experimental .60 is not the production final acceptance threshold',async()=>{
 const h=harness({limits:{maxRounds:1},coverage:id=>id.endsWith('.gap')?'none':id.endsWith('.coverage')?.7:.95})
 assert.notEqual((await h.run()).questions[0].status,'covered')
})
await test('optional facts are judged independently and retained in final check',async()=>{
 const h=harness({limits:{maxRounds:1},search:()=>[hit(1),hit(2)],source:(id,state)=>{
  if(/injection|premise_conflict/.test(id))return .02
  if(id.includes('.fact')){
   const ref=state.candidates.find(c=>c.id===id.split('.')[1])
   const url=state.sources[ref.source_index].url
   if(id.endsWith('.support'))return (url.includes('source1.')===id.includes('.fact0.'))?.94:.1
  }
  return .94
 }})
 const r=await h.run({tasks:[{context:'Testing evidence',targets:[{id:'a',keywords:['alpha'],question:'Describe alpha behavior',facts:[{id:'cancel',question:'Is the task cancelled?'},{id:'time',question:'Can cleanup exceed the timeout?'}]}]}]})
 assert.equal(r.questions[0].status,'covered');assert.equal(r.questions[0].keywordProgress[0].F,.94)
 assert.equal(h.calls.jev.filter(c=>c.phase==='fact_bundle').length,0)
 const final=h.calls.jev.find(c=>c.phase==='coverage_judge')
 assert.equal(final.state.evidence.length,2);assert.equal(final.state.questions[0].facts.length,2)
})
await test('text containment cannot remove the late complementary fact from final material',async()=>{
 const a=randomText(1), b=a+' Extra evidence explaining a distinct missing condition clearly.'
 const h=harness({limits:{maxRounds:1},search:()=>[{...hit(1),snippet:a},{...hit(2),snippet:b}],source:(id,state)=>{
  if(/injection|premise_conflict/.test(id))return .02
  if(id.endsWith('.support')){
   const ref=state.candidates.find(c=>c.id===id.split('.')[1])
   const isExtra=state.sources[ref.source_index].fragments[ref.fragment_index].text.includes('Extra evidence')
   return isExtra===id.includes('.fact1.')?.94:.1
  }
  return .94
 }})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'First requirement; Additional requirement'}]}]})
 assert.equal(r.questions[0].status,'covered')
 assert.equal(h.calls.jev.find(c=>c.phase==='coverage_judge').state.evidence.length,2)
})
await test('missing fact witnesses due to final text budget cannot be silently discarded',async()=>{
 const h=harness({limits:{maxRounds:1,maxCoverageEvidencePerQuestion:1},search:()=>[hit(1),hit(2)],source:(id,state)=>{
  if(/injection|premise_conflict/.test(id))return .02
  if(id.endsWith('.stance')){
   const ref=state.candidates.find(c=>c.id===id.split('.')[1]);return state.sources[ref.source_index].url.includes('source1.')?'support':'refute'
  }
  return .94
 }})
 const r=await h.run();assert.notEqual(r.questions[0].status,'covered')
 assert.equal(h.calls.jev.filter(c=>c.phase==='coverage_judge').length,0)
 assert.ok(r.warnings.some(w=>w.includes('witness')))
})

await test('eight explicit facts cannot be declared covered with a wholly unsupported one',async()=>{
 const h=harness({limits:{maxRounds:1},search:()=>[hit(1),hit(2)],source:id=>/injection|premise_conflict/.test(id)?0:id.includes('.fact7.')&&id.endsWith('.support')?0:1,
  bundle:id=>id.endsWith('.stance')?'support':id.includes('.fact7.')?0:1})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'Answer every listed requirement',facts:Array.from({length:8},(_,i)=>({id:`f${i}`,question:`Requirement ${i}?`}))}]}]})
 assert.ok(r.questions[0].keywordProgress[0].score>1)
 assert.equal(r.questions[0].keywordProgress[0].ready,false)
 assert.notEqual(r.questions[0].status,'covered');assert.equal(h.calls.jev.filter(c=>c.phase==='coverage_judge').length,0)
})
await test('final-check call headroom can stop draining while reporting pending honestly',async()=>{
 const h=harness({limits:{maxJevCalls:3},search:()=>Array.from({length:100},(_,i)=>hit(i))})
 const r=await h.run();assert.equal(r.usage.jevCalls,3);assert.equal(r.questions[0].status,'covered')
 assert.ok(r.funnel.pending_associations>0);assert.ok(r.warnings.some(w=>w.includes('headroom')))
})
await test('optional bundles do not consume the last mandatory final-check call',async()=>{
 const h=harness({limits:{maxJevCalls:3,maxRounds:1},search:()=>[hit(1),hit(2)],source:id=>/injection|premise_conflict/.test(id)?.02:id.endsWith('.support')?.1:.94})
 const r=await h.run();assert.equal(h.calls.jev.filter(c=>c.phase==='fact_bundle').length,0)
 assert.notEqual(r.questions[0].status,'covered');assert.ok(r.warnings.some(w=>w.includes('headroom')))
})
await test('transient optional bundle failure does not end the whole search',async()=>{
 let complete=false
 const h=harness({limits:{maxRounds:2},search:(args,n)=>{complete=n>1;return n===1?[hit(1),hit(2)]:[hit(3)]},fail:phase=>phase==='fact_bundle',
  source:id=>/injection|premise_conflict/.test(id)?.02:id.endsWith('.support')&&!complete?.1:.94})
 const r=await h.run();assert.equal(r.questions[0].status,'covered');assert.equal(r.rounds,2)
 assert.ok(r.warnings.some(w=>w.includes('optional fact-bundle assessment failed')))
})
await test('dates required only inside explicit facts are still code-gated',async()=>{
 const h=harness({limits:{maxRounds:1},search:()=>[hit(1),hit(2)]})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'Describe the event',facts:[{id:'date',question:'What occurred on 2026-01-01?'}]}]}]})
 assert.equal(r.questions[0].keywordProgress[0].F,0);assert.notEqual(r.questions[0].status,'covered')
})
await test('maximum-length fact metadata remains bounded and is not repeated for synonyms',async()=>{
 const h=harness({limits:{maxRounds:1,maxJevCalls:1}})
 const arg={tasks:Array.from({length:3},(_,t)=>({context:`Task${t} `+'c'.repeat(390),targets:Array.from({length:4},(_,q)=>({id:`target${q}`,keywords:Array.from({length:4},(_,k)=>`k${k}`+'x'.repeat(98)),question:`Question${q} `+'q'.repeat(389),facts:Array.from({length:8},(_,f)=>({id:`f${f}`+'i'.repeat(62),question:`Fact${f} `+'r'.repeat(394)}))}))}))}
 const r=await h.run(arg);assert.equal(r.questions.length,12)
 assert.ok(JSON.stringify(r).length<=ADAPTIVE_LIMITS.maxOutputChars)
 for(const q of r.questions){assert.ok(q.keywordProgress[0].factProgress);assert.equal(q.keywordProgress[1].factProgress,undefined)}
})
await test('asymmetric relevance/evidence gates survive cross-keyword selection and bundles',async()=>{
 for(const partial of [false,true]){
  const h=harness({limits:{maxRounds:1},thresholds:{relevance:.5,statesEvidence:.7},search:()=>[hit(1),hit(2)],source:(id,state)=>{
   if(/injection|premise_conflict/.test(id))return .02
   if(id.endsWith('.support'))return partial?.2:.99
   if(id.includes('.kw')){
    const ref=state.candidates.find(c=>c.id===id.split('.')[1]);const first=state.sources[ref.source_index].url.includes('source1.')
    const valid=first===id.includes('.kw0.')
    if(id.endsWith('.relevant'))return valid?.6:.95
    if(id.endsWith('.states_evidence'))return valid?.8:.69
   }
   return .99
  },bundle:id=>id.endsWith('.stance')?'support':.99})
  const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha','beta'],question:'Explain behavior'}]}]})
  assert.equal(r.questions[0].status,'covered')
 }
})
await test('small source micro-batches rotate targets rather than starving later targets',async()=>{
 const h=harness({limits:{maxRounds:1,maxJevCalls:4,maxSourceJudgeCandidatesPerRequest:1},search:()=>[hit(1),hit(2),hit(3)]})
 const r=await h.run({tasks:[{context:'Testing',targets:[{id:'a',keywords:['alpha'],question:'Alpha?'},{id:'b',keywords:['beta'],question:'Beta?'}]}]})
 const sourceCalls=h.calls.jev.filter(c=>c.phase==='source_judge')
 assert.deepEqual(sourceCalls.slice(0,2).map(c=>c.state.candidates[0].for_question),['q1','q2'])
 assert.ok(r.questions.every(q=>q.status==='covered'));assert.ok(r.funnel.pending_associations>0)
})
await test('12 targets x4 keywords x8 facts remains bounded and reports pressure honestly',async()=>{
 const h=harness({limits:{maxRounds:1,maxJevCalls:16,maxSourceJudgeCandidatesPerRequest:2},search:(args,n)=>Array.from({length:args.maxResults},(_,i)=>hit(n*100+i))})
 const tasks=Array.from({length:3},(_,t)=>({context:`Task ${t}`,targets:Array.from({length:4},(_,q)=>({id:`target${q}`,question:`Describe behavior ${q}`,keywords:['alpha','beta','gamma','delta'],facts:Array.from({length:8},(_,f)=>({id:`f${f}`,question:`Explain requirement ${f} ${'detail '.repeat(45)}`}))}))}))
 const r=await h.run({tasks});assert.equal(r.questions.length,12)
 assert.equal(r.evidence.sources,500);assert.ok(r.usage.jevCalls<=16)
 assert.ok(r.usage.jevInputTokensEstimated<=ADAPTIVE_LIMITS.maxJevInputTokens)
 assert.ok(r.funnel.pending_associations>0);assert.ok(JSON.stringify(r).length<=ADAPTIVE_LIMITS.maxOutputChars)
 console.log('multi-target pressure',JSON.stringify({calls:r.usage.jevCalls,tokens:r.usage.jevInputTokensEstimated,pending:r.funnel.pending_associations}))
})
console.log(`${passed} fact-aware tests passed (hermetic; frozen V2 comparison, not the default retrieval mode)`)
