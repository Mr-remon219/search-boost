import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync,readlinkSync,symlinkSync } from 'node:fs'
import { join,dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT,getVersion } from '../lib/pkg.mjs'
import { PATHS } from '../lib/paths.mjs'
import { installationStatus } from '../lib/installation-status.mjs'
import { runTui } from '../lib/installer/tui.mjs'
import { saveTuiLanguage } from '../lib/installer/i18n.mjs'
const secret='fixture-secret-not-for-status'
const write=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof v==='string'?v:JSON.stringify(v))}
write(PATHS.cursor.mcp,{mcpServers:{'search-boost':{command:process.execPath,args:[join(PKG_ROOT,'cli.mjs'),'serve'],disabled:true,env:{TOKEN:secret}}}})
write(PATHS.codex.config,`[ "mcp_servers" . "search\\u002dboost" ]\ncommand="node"\n'args'=[\n '${join(PKG_ROOT,'cli.mjs')}', # comment\n 'serve',\n]\n[mcp_servers.other]\ncommand="keep"\n`)
write(join(PATHS.pi.agentDir,'settings.json'),{packages:['npm:search-boost@0.0.1','npm:pi-search-boost@0.0.1'],extensions:[join(PKG_ROOT,'adapters/pi/index.js')]})
write(join(PATHS.pi.agentDir,'npm/node_modules/search-boost/package.json'),{name:'search-boost',version:'0.0.1'})
write(join(PATHS.pi.agentDir,'npm/node_modules/pi-search-boost/package.json'),{name:'pi-search-boost',version:'0.0.1'})
const profile=join(PATHS.dsh.profiles,'fixture')
write(join(profile,'package.json'),{dependencies:{'search-boost':'0.2.4-beta.5'}})
write(join(profile,'node_modules/search-boost/package.json'),{name:'search-boost',version:getVersion()})
write(join(profile,'cordis.yml'),'plugins:\n  ~search-boost: {}\n')
write(PATHS.claude.config,'{"broken":"'+secret+'"')
function snapshot(path) {
  let info;try{info=lstatSync(path)}catch{return null}
  if(info.isSymbolicLink())return {link:readlinkSync(path)}
  if(info.isFile())return {mode:info.mode&0o777,data:readFileSync(path).toString('base64')}
  return Object.fromEntries(readdirSync(path).sort().map(name=>[name,snapshot(join(path,name))]))
}
const before=snapshot(process.env.HOME)
const status=await installationStatus()
assert.equal(status.schemaVersion,1)
assert.equal(status.package.version,getVersion())
for(const host of ['cursor','codex']){
 const row=status.agents.find(row=>row.id===host)
 assert.equal(row.loadedVersion,null)
 assert.equal(row.reload,'unconfirmed_restart_or_reconnect')
 assert.equal(row.registrations[0].installedVersion,getVersion())
 assert.equal(row.registrations[0].payload,'matches_current_package')
}
const pi=status.agents.find(row=>row.id==='pi')
assert(pi.registrations[0].sources.some(row=>row.installedVersion==='0.0.1'&&row.payload==='not_verified'))
assert(pi.registrations[0].sources.some(row=>row.payload==='matches_current_package'))
const dsh=status.agents.find(row=>row.id==='dsh')
assert.equal(dsh.registrations[0].hostResolution,'unverified')
assert.equal(dsh.registrations[0].payload,'not_verified','equal labels cannot prove content')
assert.equal(dsh.loadedVersion,null)
assert(status.configurationWarnings>0)
assert(!JSON.stringify(status).includes(secret))
assert.deepEqual(snapshot(process.env.HOME),before,'backend must not mutate config, disabled rows or private state')
const cli=(...args)=>{const p=spawnSync(process.execPath,[join(PKG_ROOT,'cli.mjs'),...args],{env:process.env,encoding:'utf8',timeout:120000});assert.equal(p.status,0,p.stderr);return p.stdout}
const machine=JSON.parse(cli('status','--json'))
assert.equal(machine.package.root,PKG_ROOT)
assert(machine.agents.every(row=>row.loadedVersion===null))
assert(!JSON.stringify(machine).includes(secret))
const text=cli('status')
assert.match(text,/Current package:/);assert.match(text,/Running host version \/ reload: unknown/)
assert.match(text,/disk version 0.0.1/)
assert(text.includes('npm/node_modules/search-boost')||text.includes('npm\\node_modules\\search-boost'))
assert(text.includes('legacy; refresh via Update'))
assert(!text.includes(secret))
assert.deepEqual(snapshot(process.env.HOME),before,'CLI status must be read-only')
for(const language of ['en','zh-CN']){
 saveTuiLanguage(language)
 const initial=snapshot(process.env.HOME),actions=['status','exit'],notes=[]
 const noop=()=>{},clack={intro:noop,outro:noop,isCancel:()=>false,select:async()=>actions.shift(),note:(text,title)=>notes.push(title+'\n'+text),log:{info:noop,warn:noop,error:msg=>{throw Error(msg)}}}
 await runTui({}, {clack})
 assert.equal(actions.length,0)
 assert(notes.some(note=>note.includes(language==='en'?'Running host version / reload: unknown':'运行中宿主版本 / 重载：未知')))
 assert(notes.some(note=>note.includes('0.0.1')))
 assert(notes.some(note=>note.includes(language==='en'?'legacy; refresh via Update':'旧版；请通过更新刷新')))
 assert(!notes.join('\n').includes(secret))
 assert.deepEqual(snapshot(process.env.HOME),initial)
}
console.log('ok: public CLI JSON/text and bilingual real TUI use read-only disk evidence; quoted/multiline TOML, stale Pi, disabled DSH and secret-bearing bad configs remain intact; loaded version stays unknown')
