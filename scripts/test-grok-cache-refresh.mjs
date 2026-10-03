#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { refreshGrokPlugin, resolveGrokPluginDir } from '../lib/grok-plugin.mjs'
import { confirmGrokCacheRepair } from '../lib/installer/grok-consent.mjs'
const root=join(process.env.HOME,'grok-cache-fixtures')
mkdirSync(root,{recursive:true})
let index=0
function fixture({same=false, disabled=false, updateWorks=false, removalFails=false, installFails=false, extraPlugin=false}={}) {
 const base=join(root,String(++index)),source=join(base,'source'),cache=join(base,'cache')
 mkdirSync(base,{recursive:true});cpSync(resolveGrokPluginDir(),source,{recursive:true});cpSync(source,cache,{recursive:true})
 if(!same){const m=JSON.parse(readFileSync(join(cache,'plugin.json')));m.version='0.2.0';m.author='search-boost';writeFileSync(join(cache,'plugin.json'),JSON.stringify(m))}
 let present=true;const calls=[]
 const plugin={name:'grok-plugin-legacy',repo_key:'fixture-repo',path:cache,source,status:disabled?'disabled':'installed',version:null}
 const run=async (_command,args)=>{
  calls.push(args)
  if(args[1]==='list')return {code:0,stdout:JSON.stringify(present?[plugin,...(extraPlugin?[{name:'unrelated',repo_key:plugin.repo_key,path:join(base,'other'),source}]:[])]:[])}
  if(args[1]==='update'){if(updateWorks){rmSync(cache,{recursive:true});cpSync(source,cache,{recursive:true})}return {code:0,stdout:'local symlink, already live'}}
  if(args[1]==='validate')return {code:0,stdout:'valid'}
  if(args[1]==='uninstall'){if(removalFails)return {code:1,stdout:'',stderr:'private-fixture-secret'};assert.deepEqual(args,['plugin','uninstall',plugin.name,'--keep-data']);present=false;return {code:0,stdout:''}}
  if(args[1]==='install'){if(installFails)return {code:1,stdout:'',stderr:'private-fixture-secret'};assert.deepEqual(args,['plugin','install',source,'--trust']);cpSync(source,cache,{recursive:true});present=true;plugin.name='search-boost';return {code:0,stdout:''}}
  throw new Error(`Unexpected fixture command ${args}`)
 }
 return {source,cache,calls,run,plugin}
}
let f=fixture({same:true})
assert.equal((await refreshGrokPlugin({run:f.run,pluginDir:f.source})).status,'current')
assert.equal(f.calls.length,1)
f=fixture({updateWorks:true})
assert.equal((await refreshGrokPlugin({run:f.run,pluginDir:f.source})).status,'updated')
assert(!f.calls.some(a=>a.includes('--trust')))
for(const consent of [false,undefined,'yes']){
 f=fixture();await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,confirmRepair:async()=>consent}),/cancelled/)
 assert(!f.calls.some(a=>['uninstall','install'].includes(a[1])))
}
f=fixture();await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source}),/cache payload remains stale/)
assert(!f.calls.some(a=>a.includes('--trust')))
f=fixture();const result=await refreshGrokPlugin({run:f.run,pluginDir:f.source,confirmRepair:async plan=>{
 assert.equal(plan.name,'grok-plugin-legacy');assert.equal(plan.source,f.source);assert.equal(plan.path,f.cache);assert(Object.isFrozen(plan));return true
}})
assert.equal(result.status,'updated');assert.deepEqual(readFileSync(join(f.source,'plugin.json')),readFileSync(join(f.cache,'plugin.json')))
for(const mutation of ['source','cache','registration','repo']){
 f=fixture();await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,confirmRepair:async()=>{
  if(mutation==='registration')f.plugin.name='another-name'
  else if(mutation==='repo')f.plugin.repo_key='changed-repository'
  else writeFileSync(join(f[mutation],'README.md'),'changed-after-consent')
  return true
 }}),/changed after the preview/)
 assert(!f.calls.some(a=>a[1]==='uninstall'))
}
f=fixture({disabled:true});assert.equal((await refreshGrokPlugin({run:f.run,pluginDir:f.source,repair:true})).status,'disabled');assert.equal(f.calls.length,1)
f=fixture({extraPlugin:true});await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,repair:true}),/other plugins/);assert(!f.calls.some(a=>a[1]==='uninstall'))
f=fixture({removalFails:true});await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,repair:true}),/cache removal failed/);assert(!f.calls.some(a=>a[1]==='install'))
f=fixture({installFails:true});await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,repair:true}),error=>{
 assert.match(error.message,/cache reinstallation failed/);assert.match(error.message,/removal already succeeded/);assert.match(error.message,/Refresh does not install an absent plugin/);return true
})
for(const repoKey of [undefined,null,'',{},42]){
 f=fixture();f.plugin.repo_key=repoKey
 await assert.rejects(refreshGrokPlugin({run:f.run,pluginDir:f.source,repair:true}),/repository identity cannot be verified/)
 assert(!f.calls.some(a=>a[1]==='uninstall'))
}
f=fixture();assert.equal((await refreshGrokPlugin({run:f.run,pluginDir:f.source,dryRun:true,repair:true})).status,'planned');assert.equal(f.calls.length,1)
const plan={name:'fixture',source:'/fixture/source',path:'/fixture/cache',version:'1.0.0'}
for(const value of [false,undefined,'yes',true]){
 const consent=await confirmGrokCacheRepair({note:()=>{},confirm:async options=>{assert.equal(options.initialValue,false);return value},isCancel:()=>false},plan)
 assert.equal(consent,value===true)
}
// Escape during an in-flight operation must decline, never hard-exit siblings.
const cancelled=Symbol('cancel'),originalExit=process.exit
try {
 process.exit=()=>{throw Error('hard exit during cache confirmation')}
 assert.equal(await confirmGrokCacheRepair({note:()=>{},confirm:async()=>cancelled,isCancel:v=>v===cancelled,cancel:()=>{}},plan),false)
} finally {process.exit=originalExit}
console.log('ok: Grok stale local cache repair is native-only, exact-consent-bound, legacy-aware, verified and fails closed')
