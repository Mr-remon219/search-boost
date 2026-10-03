#!/usr/bin/env node
import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runTui } from '../lib/installer/tui.mjs'
import { runInstallerWithOptions } from '../lib/installer/index.mjs'
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
 console.log('ok: both management layouts dispatch scoped refresh, preserve choices, reject expansion and disclose partial install failure')
} finally {process.exitCode=savedExit}
