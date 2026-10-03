#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runTui } from '../lib/installer/tui.mjs'
import { runInstallerWithOptions, runInstallPlain } from '../lib/installer/index.mjs'
import { saveTuiLanguage, saveTuiLayout } from '../lib/installer/i18n.mjs'
import { PATHS } from '../lib/paths.mjs'
import { AGENTS } from '../lib/agents/index.mjs'
import { runRefresh } from '../lib/upgrade/index.mjs'
const savedExit = process.exitCode
const write = (file, value) => { mkdirSync(dirname(file), {recursive:true});writeFileSync(file,JSON.stringify(value)) }
write(PATHS.cursor.mcp,{mcpServers:{'search-boost':{command:'old',args:[],env:{TOKEN:'fixture-secret'},disabled:true}}})
saveTuiLanguage('en')
async function scenario(actions, refresh, layout='flat') {
 saveTuiLayout(layout);process.exitCode=undefined
 const records=[],logs=[],calls=[]
 const clack={intro:()=>{},outro:()=>{},isCancel:()=>false,note:(text,title)=>logs.push(`${title}\n${text}`),
  log:Object.fromEntries(['info','error','warn','success'].map(kind=>[kind,text=>logs.push(`${kind}: ${text}`)]))}
 for(const method of ['select','multiselect'])clack[method]=async menu=>{
  records.push({method,...menu});assert(actions.length,`unexpected ${menu.message}`)
  const action=actions.shift();return typeof action==='function'?action(menu):action
 }
 await runTui({dryRun:true},{clack,refresh:async opts=>{calls.push(opts);return refresh?refresh(opts):{ok:true,results:[]}}})
 assert.equal(actions.length,0)
 return {records,logs,calls,exitCode:process.exitCode}
}
try {
 const pick=menu=>[menu.options.find(o=>o.label==='cursor').value]
 for(const layout of ['flat','folder']){
  const prefix=layout==='folder'?['integration','manage']:['manage']
  const suffix=layout==='folder'?['back','back','exit']:['back','exit']
  const out=await scenario([...prefix,'refresh',pick,...suffix],undefined,layout)
  const menus=out.records
  assert(menus.every(m=>!m.options.some(o=>o.value==='upgrade')))
  assert.deepEqual(menus.find(m=>m.message==='Manage agent integrations').options.map(o=>o.value),['install','refresh','uninstall','back'])
  assert.equal(out.calls.length,1);assert.equal(out.calls[0].selected.length,1)
  assert.equal(out.calls[0].dryRun,true);assert.equal(typeof out.calls[0].confirmGrokRepair,'function')
  assert(out.logs.some(l=>l.includes('current SearchBoost package only')))
 }
 let out=await scenario(['manage','refresh',[], 'back','exit'])
 assert.equal(out.calls.length,0);assert(out.logs.some(l=>l.includes('nothing was changed')))
 out=await scenario(['manage','refresh',pick,'back','exit'],async()=>({ok:false,results:[{ok:false}]}))
 assert.equal(out.exitCode,1)
 out=await scenario(['manage','refresh',pick,'back','exit'],async()=>{throw Error('fixture failure')})
 assert.equal(out.exitCode,1);assert(out.logs.some(l=>l.includes('fixture failure')))
 // A target appearing after selection is not added to the consented execution set.
 const unselected = JSON.stringify({mcpServers:{'search-boost':{command:'untouched',args:[]}}})
 out=await scenario(['manage','refresh',pick,'back','exit'],async opts=>{
  mkdirSync(dirname(PATHS.claude.config),{recursive:true});writeFileSync(PATHS.claude.config,unselected)
  return runRefresh({...opts,dryRun:false,run:async()=>{throw Error('No host commands expected for selected MCP-only refresh')}})
 })
 assert.equal(out.calls.length,1);assert.equal(readFileSync(PATHS.claude.config,'utf8'),unselected)
 const cursor=JSON.parse(readFileSync(PATHS.cursor.mcp))
 assert.equal(cursor.mcpServers['search-boost'].disabled,true);assert.equal(cursor.mcpServers['search-boost'].env.TOKEN,'fixture-secret')
 // An embedded installer must report partial failure, not a success-styled completion.
 const original=AGENTS.cursor.install,logs=[]
 AGENTS.cursor.install=async()=>{throw Error('fixture-install-failure')}
 try {
  const clack={intro:()=>{},outro:()=>{},isCancel:()=>false,note:()=>{},confirm:async()=>false,spinner:()=>({start:()=>{},stop:text=>logs.push(text)}),log:Object.fromEntries(['info','error','warn','success'].map(k=>[k,text=>logs.push(text)]))}
  const result=await runInstallerWithOptions({clack,target:'cursor',skipKeys:true,skipLayer:true,skipXAuth:true,autoAllow:false,replaceNative:false})
  assert.equal(result.ok,false);assert.equal(result.results.length,1)
  assert(logs.some(l=>l.includes('Partially completed: 1 target(s) failed')))
  assert(!logs.includes('install complete'));assert(logs.some(l=>l.includes('Failed targets: cursor')))
 } finally {AGENTS.cursor.install=original}
 // Selecting only Grok MCP must not dispatch the separately unchecked native plugin.
 mkdirSync(dirname(PATHS.grok.config),{recursive:true});writeFileSync(PATHS.grok.config,'[mcp_servers.search-boost]\ncommand="old"\nargs=[]\n')
 const {discoverIntegrations,integrationTargetKey}=await import('../lib/upgrade/integrations.mjs')
 const grok=(await discoverIntegrations()).targets.find(t=>t.id==='grok')
 const commands=[]
 const scoped=await runRefresh({selected:[integrationTargetKey(grok)],dryRun:true,log:()=>{},run:async(command,args)=>{commands.push([command,args]);return {code:0,stdout:'[]'}}})
 assert(scoped.ok);assert.equal(commands.length,0,'unchecked Grok native plugin must not be dispatched')
 // Plain -t install is intentionally non-interactive, including cache recovery.
 const originalGrok=AGENTS.grok.install
 try {
  AGENTS.grok.install=async opts=>{assert.equal(opts.confirmGrokRepair,undefined,'plain install must not contain a broken interactive callback');return []}
  await runInstallPlain({target:'grok',dryRun:true,replaceNative:false})
 } finally {AGENTS.grok.install=originalGrok}
 // CLI cache Escape must finish sibling jobs, persist failure and release locks.
 const {runRefreshCli}=await import('../lib/upgrade/cli.mjs')
 const {resolveGrokPluginDir}=await import('../lib/grok-plugin.mjs')
 const {searchBoostHome}=await import('../lib/config-paths.mjs')
 const cache=join(process.env.HOME,'cli-cancel-cache'),source=resolveGrokPluginDir(),cancelled=Symbol('cancel')
 cpSync(source,cache,{recursive:true});writeFileSync(join(cache,'README.md'),'stale fixture')
 const hostCalls=[],cliLogs=[];let confirms=0
 const clack={note:()=>{},confirm:async options=>{confirms++;assert.equal(options.initialValue,confirms===1);return confirms===1?true:cancelled},isCancel:value=>value===cancelled,cancel:()=>{}}
 const exit=process.exit
 try {
  process.exit=()=>{throw Error('CLI exited during an active refresh')}
  const result=await runRefreshCli([],{clack,log:text=>cliLogs.push(text),run:async(command,args)=>{
   hostCalls.push([command,args]);assert.equal(command,'grok');assert(['list','update'].includes(args[1]),'decline must not uninstall/trust')
   return {code:0,stdout:args[1]==='list'?JSON.stringify([{name:'search-boost',repo_key:'fixture',source,path:cache,status:'installed'}]):'already live'}
  }})
  assert.equal(confirms,2);assert.equal(result.ok,false);assert.equal(process.exitCode,1)
  assert(result.results.some(r=>r.target==='grok plugin'&&!r.ok&&r.error.includes('cancelled')))
  assert(result.results.some(r=>r.target==='cursor'&&r.ok),'sibling transactions complete despite cancelled plugin consent')
  assert(cliLogs.some(l=>l.includes('Refresh incomplete')))
  assert.equal(JSON.parse(readFileSync(join(searchBoostHome(),'state','last-refresh.json'))).ok,false)
 } finally {process.exit=exit}
 console.log('ok: management scopes, plain install, in-flight CLI cancellation, preservation and partial failure reporting')
} finally {process.exitCode=savedExit}
