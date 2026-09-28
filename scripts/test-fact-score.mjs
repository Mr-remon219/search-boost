#!/usr/bin/env node
import './isolate-tests.mjs'
// Algebra/provenance invariants, not model accuracy or live retrieval evidence.
import assert from 'node:assert/strict'
import { scoreEvidence, FACT_SCORE_WEIGHTS } from '../lib/search/adaptive/keyword-progress.js'
import { factUnits } from '../lib/search/adaptive/facts.js'
import { normalizeAdaptiveInput, canonicalTargets } from '../lib/search/adaptive/input.js'
import { buildSourceJudgeRequest, factBundleRequest } from '../lib/search/adaptive/prompts.js'
import { createHash } from 'node:crypto'
const approx = (a,b) => assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`)
const text = n => Array.from({length:12},(_,i)=>createHash('sha256').update(`${n}/${i}`).digest('hex')).join(' ')
const facts=[{id:'cancel',weight:.5},{id:'time',weight:.5}]
const row=(id,factId='cancel',extra={})=>({evidenceId:id,text:text(id),url:`https://${id}.test/page`,judgment:{relevant:.94,states_evidence:.94,injection:.02},facts:[{factId,support:.94,stance:'support',independent:.95}],...extra})
const one=rows=>scoreEvidence(rows,{facts:[{id:'cancel',weight:1}]})
const both=rows=>scoreEvidence(rows,{facts})
let passed=0
function test(name,fn){try{fn();passed++;console.log('ok',name)}catch(e){process.exitCode=1;console.error('FAIL',name,e)}}

test('first complete evidence crosses one; base increment is max, not sum',()=>{
 const a=row('a'),b=row('b')
 const score=one([a]);assert.ok(score.ready);approx(score.A,.94);approx(score.F,.94);assert.equal(score.R,0)
 const two=one([a,b]);approx(two.A,score.A);approx(two.F,score.F);approx(two.R,.47)
})
test('same-fact independent corroboration has geometrically decreasing increments',()=>{
 const scores=[1,2,3,4].map(n=>one(Array.from({length:n},(_,i)=>row(`source${i}`))))
 const deltas=scores.slice(1).map((s,i)=>s.score-scores[i].score)
 approx(deltas[1]/deltas[0],.5);approx(deltas[2]/deltas[1],.5)
 const saturated=one(Array.from({length:100},(_,i)=>row(`many${i}`)))
 assert.ok(saturated.R<=1);assert.ok(saturated.score<=FACT_SCORE_WEIGHTS.alpha+FACT_SCORE_WEIGHTS.beta+FACT_SCORE_WEIGHTS.gamma)
})
test('independent restatements cannot fill a different missing fact',()=>{
 const s=both(Array.from({length:100},(_,i)=>row(`source${i}`)))
 assert.deepEqual(s.missingFacts,['time']);approx(s.F,.47);assert.equal(s.ready,false)
})
test('a late new fact earns exactly the same coverage gain',()=>{
 const first=row('a'),newFact=row('b','time')
 const repeats=Array.from({length:30},(_,i)=>row(`repeat${i}`))
 approx(both([first,newFact]).F-both([first]).F,both([first,...repeats,newFact]).F-both([first,...repeats]).F)
 assert.ok(both([first,...repeats,newFact]).ready)
})
test('same-site complementary facts add F without source independence credit',()=>{
 const a=row('a','cancel',{url:'https://official.test/a'}),b=row('b','time',{url:'https://official.test/b'})
 const s=both([a,b]);approx(s.F,.94);assert.equal(s.R,0);assert.ok(s.ready)
})
test('500 mirrors with different domains do not create corroboration',()=>{
 const original=row('original')
 const copies=Array.from({length:500},(_,i)=>({...original,evidenceId:`copy${i}`,url:`https://mirror${i}.test/a`}))
 approx(one(copies).score,one([original]).score);assert.equal(one(copies).distinct,1)
})
test('short exact duplicates are grouped; unknown provenance cannot earn R',()=>{
 const a=row('a','cancel',{text:'Yes'}),b=row('b','cancel',{text:'Yes'})
 assert.equal(one([a,b]).R,0)
 const unknown=Array.from({length:20},(_,i)=>row(`x${i}`)).map(r=>({...r,facts:r.facts.map(f=>({...f,independent:null}))}))
 assert.equal(one(unknown).R,0)
})
test('paraphrases with no original provenance earn no corroboration',()=>{
 const a=row('a','cancel',{text:'The request expires after the allowed duration.'})
 const b=row('b','cancel',{text:'超过规定时间后请求失效。',facts:[{factId:'cancel',support:.94,stance:'support',independent:.05}]})
 assert.equal(one([a,b]).R,0)
})
test('support and refutation are not mutual corroboration; both remain witnesses',()=>{
 const a=row('a'),b=row('b','cancel',{facts:[{factId:'cancel',support:.94,stance:'refute',independent:.95}]})
 const s=one([a,b]);assert.equal(s.R,0);assert.equal(s.factProgress[0].conflicting,true)
 assert.deepEqual(new Set(s.witnesses),new Set(['a','b']))
})
test('permutation invariance of A/F/R and witness identities',()=>{
 const rows=[row('a'),row('b'),row('c','time'),row('d','time'),row('e')]
 const expected=both(rows)
 for(let i=0;i<rows.length;i++){
  const rotated=[...rows.slice(i),...rows.slice(0,i)].reverse()
  const s=both(rotated);approx(s.A,expected.A);approx(s.F,expected.F);approx(s.R,expected.R)
  assert.deepEqual(new Set(s.witnesses),new Set(expected.witnesses))
 }
})
test('absent/invalid facts or stance cannot be inferred from quality or text novelty',()=>{
 for(const f of [[],[{factId:'cancel',support:null,stance:'support'}],[{factId:'cancel',support:.95,stance:'unknown'}],[{factId:'cancel',support:2,stance:'support'}]]){
  const s=one([row('a','cancel',{facts:f})]);assert.equal(s.F,0);assert.equal(s.ready,false)
 }
 assert.equal(scoreEvidence([row('a')]).ready,false)
 assert.throws(()=>scoreEvidence([],{facts:[{id:'a',weight:.4}]}))
})
// Independent numeric validity check (invalid judgments must be rejected, not thrown).
test('NaN, out-of-range and missing injection never qualify',()=>{
 for(const judgment of [{relevant:NaN,states_evidence:.99,injection:0},{relevant:2,states_evidence:.99,injection:0},{relevant:.99,states_evidence:.99}])assert.equal(one([row('a','cancel',{judgment})]).score,0)
})
test('bundle coverage never becomes independent corroboration and traces actual witnesses',()=>{
 const a=row('a','cancel',{facts:[]}),b=row('b','cancel',{facts:[]})
 const union=row('bundle','cancel',{bundle:true,witnesses:['a','b']})
 const s=scoreEvidence([a,b],{facts:[{id:'cancel',weight:1}],coverageRows:[a,b,union]})
 assert.ok(s.ready);assert.equal(s.R,0);assert.deepEqual(s.witnesses,['a','b'])
})
test('fixed unit extraction preserves all requirements and bounds IDs',()=>{
 const q={acceptance:'Does it cancel? Can cleanup exceed the timeout?'}
 assert.equal(factUnits(q).length,2)
 assert.equal(factUnits({acceptance:'a;b;c;d;e;f;g;h;i'}).length,1)
 const explicit=factUnits({facts:[{id:'time',question:'What is the time bound?'}]})
 assert.deepEqual(explicit,[{id:'time',question:'What is the time bound?',weight:1}])
})
test('strict optional fact input and canonical target isolation',()=>{
 const target={id:'t',question:'Explain behavior',keywords:['alpha'],facts:[{id:'x',question:'Does it cancel?'}]}
 const input=t=>({tasks:[{context:'Test',targets:[t]}]})
 const valid=normalizeAdaptiveInput(input(target));assert.equal(valid.error,undefined)
 for(const facts of [[...target.facts,...target.facts],[{id:'x',question:' '}],[{id:'x',question:'Valid?',weight:100}],Array.from({length:9},(_,i)=>({id:`f${i}`,question:'A?'}))])assert.ok(normalizeAdaptiveInput(input({...target,facts})).error)
 const second=normalizeAdaptiveInput(input({...target,facts:[{id:'y',question:'Can cleanup be delayed?'}]}))
 assert.equal(canonicalTargets([...valid.targets,...second.targets]).length,2)
})
test('actual prompt protocol supplies unit paths, stance choices and union provenance limits',()=>{
 const q={id:'q1',text:'Explain behavior',keywords:['alpha'],facts:[{id:'a',question:'Does it cancel?'}]}
 const candidate={questionId:'q1',evidenceId:'e1',assocId:'a1',textVersion:'v1',url:'https://x.test/a',text:'The task is cancelled on timeout.'}
 const request=buildSourceJudgeRequest([q],[candidate],true)
 assert.equal(request.mapping[0].facts[0].factId,'a')
 assert.equal(request.questions['src.e1.fact0.stance'].type,'choice')
 assert.ok(JSON.stringify(request.questions['src.e1.fact0.support']).includes('state.questions[0].facts[0].question'))
 assert.ok(JSON.stringify(request.questions['src.e1.fact0.independent']).includes('Unknown provenance'))
 const bundle=factBundleRequest(q,[candidate,{...candidate,evidenceId:'e2',url:'https://y.test/b'}])
 assert.ok(bundle.state.rules.some(s=>s.includes('not an independent source')))
})
test('eight required facts: an absent eighth fact is a hard readiness veto',()=>{
 const manyFacts=Array.from({length:8},(_,i)=>({id:`f${i}`,weight:1/8}))
 const rows=Array.from({length:7},(_,i)=>row(`e${i}`,`f${i}`,{judgment:{relevant:1,states_evidence:1,injection:0},facts:[{factId:`f${i}`,support:1,stance:'support',independent:1}]}))
 const score=scoreEvidence(rows,{facts:manyFacts})
 assert.ok(score.score>1);assert.equal(score.ready,false);assert.deepEqual(score.missingFacts,['f7'])
})
test('relevance and evidence have independent configured gates',()=>{
 const a=row('a','cancel',{judgment:{relevant:.6,states_evidence:.8,injection:.02}})
 const s=scoreEvidence([a],{facts:[{id:'cancel',weight:1}],gateRelevant:.5,gateStates:.7})
 assert.equal(s.eligible,1);approx(s.A,.6);assert.ok(s.F>0)
})
test('local distinct count does not inherit sibling keyword provenance',()=>{
 const a=row('a')
 const s=scoreEvidence([],{facts:[{id:'cancel',weight:1}],coverageRows:[a]})
 assert.equal(s.distinct,0);assert.equal(s.A,0);assert.ok(s.F>0);assert.equal(s.ready,false)
})
test('near-copy blocking is symmetric and cannot erase complementary coverage',()=>{
 const original=row('a'),copy=row('b','time',{text:original.text+' Extra unique statement.',facts:[{factId:'time',support:.94,stance:'support',independent:.95}]})
 const s=both([original,copy]);approx(s.F,.94);assert.equal(s.R,0)
})
console.log(`${passed} fact-score tests passed (offline invariants only)`)
