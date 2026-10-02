import './isolate-tests.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, readlinkSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PKG_ROOT } from '../lib/pkg.mjs'
import { PATHS, grokInstallPaths } from '../lib/paths.mjs'
import { assertMcpTomlEditable, upsertTomlSection, removeTomlSection } from '../lib/toml.mjs'
import { refreshTomlMcp } from '../lib/upgrade/config.mjs'
import { runInstallerWithOptions } from '../lib/installer/index.mjs'

const refusal = /Unsupported MCP TOML inline-table\/dotted-key declaration.*left unchanged/
const write = (path, text) => { mkdirSync(dirname(path), { recursive:true }); writeFileSync(path, text) }
const parse = text => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], {input:text,encoding:'utf8'})
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const run = (...args) => spawnSync(process.execPath, [join(PKG_ROOT,'cli.mjs'), ...args], {env:process.env,encoding:'utf8',timeout:120000})
const bin=join(process.env.HOME,'grok-probe-bin'),trace=join(process.env.HOME,'grok-calls'),main=join(bin,'grok.mjs')
write(main,`import {appendFileSync} from 'node:fs'; const args=process.argv.slice(2).join(' '); appendFileSync(${JSON.stringify(trace)},args+'\\n'); if(args==='plugin list --json') console.log('[]'); else throw Error('unexpected host command')`)
const launcher=join(bin,process.platform==='win32'?'grok.cmd':'grok')
write(launcher,process.platform==='win32'?`@"${process.execPath}" "${main}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`)
chmodSync(launcher,0o700); process.env.PATH=bin+delimiter+process.env.PATH
const entry = '{ command="node", args=["old"], enabled=false, env={ TOKEN="synthetic-only" } }'
const dotted = prefix => `${prefix}.command="node"\n${prefix}.args=["old"]\n${prefix}.enabled=false\n${prefix}.env.TOKEN="synthetic-only"\n`
const fixtures = [
  dotted('mcp_servers.search-boost'),
  dotted('"mcp_servers" . "search-boost"'),
  dotted("'mcp_servers'.'search-boost'"),
  dotted('"mcp\\u005fservers"."search\\u002dboost"'),
  '[mcp_servers]\n'+dotted('search-boost'),
  '["mcp_servers"]\n'+dotted('"search-boost"'),
  '[mcp_servers]\n'+dotted("'search-boost'"),
  `mcp_servers.search-boost=${entry}\n`,
  `[mcp_servers]\nsearch-boost=${entry}\n`,
  `[mcp_servers]\n"search\\u002dboost"=${entry} # an actual registration\n`,
  `mcp_servers={search-boost=${entry},other={command="keep"}}\n`,
  `"mcp\\u005fservers"={'search-boost'=${entry}}\n`,
  `mcp_servers={search-boost.command="node",search-boost.args=["old"]}\n`,
]
for(const q of ['"',"'"]) for(const run of [3,4,5]) {
  // A quote left over by the lexer can hide the following real registration;
  // an odd quote in the comment then clears the phantom and bypasses refusal.
  fixtures.push(`[mcp_servers]\nother.command="node"\nother.args=[]\nother.enabled=false\nother.env.PROMPT=${q.repeat(3)}ends with a quote${q.repeat(run)}\nsearch-boost=${entry}\n# ${q}\n`)
}
for (const text of fixtures) {
  assert.equal(parse(text).mcp_servers['search-boost'].command,'node','fixture must be a legal equivalent TOML registration')
  assert.throws(() => upsertTomlSection(text,'search-boost','command="new"\nargs=[]'),refusal)
  assert.throws(() => removeTomlSection(text,'search-boost'),refusal)
  assert.throws(() => refreshTomlMcp(text,{command:'new',args:[]}),refusal)
}
// A closed inline container also cannot be extended with a new child table.
const closed = 'mcp_servers={other={command="keep"}}\n'
assert.equal(parse(closed).mcp_servers['search-boost'],undefined)
assert.throws(() => upsertTomlSection(closed,'search-boost','command="new"'),refusal)
fixtures.push(closed)
console.log('ok: independent tomllib accepts inline/dotted fixtures; scoped editors refuse them instead of appending or falsely removing')

function snapshot(path) {
  if (!existsSync(path)) return null
  const info=lstatSync(path), mode=info.mode&0o777
  if(info.isSymbolicLink()) return {mode,link:readlinkSync(path)}
  if(info.isFile()) return {mode,bytes:readFileSync(path).toString('base64')}
  return {mode,children:Object.fromEntries(readdirSync(path).sort().map(name=>[name,snapshot(join(path,name))]))}
}
const valid = '[mcp_servers."search-boost"]\ncommand="node"\nargs=[]\n'
for (const host of ['codex','grok']) {
  write(PATHS[host].config,valid)
  const seed=run('install','-t',host,'-y','--keep-native',...(host==='grok'?['--skip-grok-plugin']:[]))
  assert.equal(seed.status,0,seed.stderr+seed.stdout)
  const roots = host==='codex' ? [join(process.env.HOME,'.codex'),join(process.env.HOME,'.agents')] : [join(process.env.HOME,'.grok')]
  for (const text of fixtures) {
    write(PATHS[host].config,text)
    const before=roots.map(snapshot)
    for(const verb of ['install','uninstall']) for(const dry of [false,true]) {
      // No Grok skip flag: rejection must precede any host plugin operation.
      rmSync(trace,{force:true})
      const result=run(verb,'-t',host,'-y','--keep-native',...(dry?['--dry-run']:[]))
      assert.equal(result.status,1,`${host} ${verb}: ${result.error?.message??''}; ${result.stderr}; ${result.stdout}`)
      assert.match(result.stderr+result.stdout,refusal)
      assert.equal(existsSync(trace),false,'guard must precede ANY Grok plugin command, including list')
      assert.deepEqual(roots.map(snapshot),before,`${host} ${verb} refusal must precede config/skill/hook/rule mutations`)
      assert.deepEqual(parse(readFileSync(PATHS[host].config,'utf8')),parse(text))
    }
  }
  // Discovery cannot silently omit config-only unsupported registrations.
  rmSync(PATHS[host].skill,{force:true})
  for(const text of [fixtures[0],fixtures[8]]) {
    write(PATHS[host].config,text)
    const before=readFileSync(PATHS[host].config)
    const result=run('upgrade','--sync-only','-y')
    assert.equal(result.status,1,result.stderr+result.stdout)
    assert.match(result.stdout+result.stderr,refusal)
    assert.match(result.stdout, /\[blocked\]/, 'discovery must block, not merely fail later in refresh')
    assert.doesNotMatch(result.stdout,new RegExp(`\\[failed\\] ${host}`))
    assert.ok(readFileSync(PATHS[host].config).equals(before))
  }
  write(PATHS[host].config,valid)
  console.log(`ok: public ${host} install/uninstall and dry-run reject legal unsupported declarations with byte/mode-identical host assets; upgrade is blocked`)
}
const noop=()=>{}, clack={log:{info:noop,warn:noop,error:noop,success:noop},isCancel:()=>false,spinner:()=>({start:noop,stop:noop}),note:noop}
write(PATHS.codex.config,fixtures[8])
const before=readFileSync(PATHS.codex.config)
await runInstallerWithOptions({clack,target:'codex',yes:true,skipKeys:true,skipLayer:true,replaceNative:false})
assert.equal(process.exitCode,1)
assert.ok(readFileSync(PATHS.codex.config).equals(before)); process.exitCode=0

// Preflight all Grok scopes, not just whichever scope first has known assets.
const project=grokInstallPaths('project')
for(const badScope of ['user','project']) {
  write(PATHS.grok.config,badScope==='user'?fixtures[0]:valid)
  write(project.config,badScope==='project'?fixtures[8]:valid)
  const before=[snapshot(join(process.env.HOME,'.grok')),snapshot(join(process.cwd(),'.grok'))]
  const result=run('uninstall','-t','grok','--scope','all','-y')
  assert.equal(result.status,1,result.stderr+result.stdout);assert.match(result.stderr+result.stdout,refusal)
  assert.deepEqual([snapshot(join(process.env.HOME,'.grok')),snapshot(join(process.cwd(),'.grok'))],before)
}
console.log('ok: interactive wrapper also refuses; Grok all-scope preflight cannot partially uninstall before a later unsupported scope')

// Lookalikes in values/comments and unrelated key paths are not registrations.
const harmless = `# mcp_servers.search-boost.command="not config"
example="""
mcp_servers.search-boost={command="not config"}
[mcp_servers]
search-boost.command="not config"
"""
"mcp_servers.search-boost"={command="unrelated single key"}
[profiles.demo]
mcp_servers.search-boost.command="not a global MCP declaration"
[mcp_servers]
search-boost-other={command="keep"}
[mcp_servers."search-boost"]
command="old"
args=[]
env.TOKEN="keep"
custom={command="keep",nested={a=1}}
`
assertMcpTomlEditable(harmless,'search-boost')
const updated=upsertTomlSection(harmless,'search-boost','command="new"\nargs=[]')
const doc=parse(updated)
assert.equal(doc.mcp_servers['search-boost'].command,'new')
assert.equal(doc.mcp_servers['search-boost'].env.TOKEN,'keep')
assert.equal(doc.mcp_servers['search-boost-other'].command,'keep')
assert.equal(doc['mcp_servers.search-boost'].command,'unrelated single key')
assert.equal(doc.profiles.demo.mcp_servers['search-boost'].command,'not a global MCP declaration')
const removed=parse(removeTomlSection(harmless,'search-boost'))
assert.equal(removed.mcp_servers['search-boost'],undefined)
assert.equal(removed.mcp_servers['search-boost-other'].command,'keep')
console.log('ok: strings/comments, literal dotted names, other servers and profile-local keys do not trigger refusal; supported env/custom inline values remain intact')

// A nested array element can look exactly like a quoted table header when its
// comma is on the next line. It is a value, not a new section (tomllib oracle).
for (const element of ['["--mode"]', "['--mode']", '[["--mode"]]']) {
  const text = `[mcp_servers.search-boost]\ncommand="old"\nargs=[]\n[mcp_servers.other]\ncommand="user-server"\ncustom=[\n  ${element}\n  ,\n  "value"\n]\n[mcp_servers.other.env]\nBRACKETS="[not.a.header]"\n`
  const original = parse(text)
  const updated = parse(upsertTomlSection(text, 'search-boost', 'command="new"\nargs=[]'))
  const removed = parse(removeTomlSection(text, 'search-boost'))
  assert.equal(updated.mcp_servers['search-boost'].command, 'new')
  assert.deepEqual(updated.mcp_servers.other, original.mcp_servers.other)
  assert.deepEqual(removed.mcp_servers.other, original.mcp_servers.other)
  assert.equal(removed.mcp_servers['search-boost'], undefined)
  write(PATHS.codex.config, text)
  for (const verb of ['install', 'uninstall']) {
    const result = run(verb, '-t', 'codex', '-y', '--keep-native')
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.deepEqual(parse(readFileSync(PATHS.codex.config, 'utf8')).mcp_servers.other, original.mcp_servers.other)
  }
}
console.log('ok: nested multiline array values never become table headers; real CLI install/uninstall preserves unrelated valid TOML')

for(const q of ['"',"'"]) for(const count of [3,4,5]) {
  const quotes=q.repeat(count)
  const text=`note=${q.repeat(3)}root value${quotes} # ${q.repeat(3)}\n[mcp_servers.search-boost]\ncommand="node"\nargs=[]\n[mcp_servers.other]\ncommand="npx"\nargs=[]\nenv.PROMPT=${q.repeat(3)}sibling value${quotes}\n`
  const original=parse(text)
  const updated=parse(upsertTomlSection(text,'search-boost','command="new"\nargs=[]'))
  const removed=parse(removeTomlSection(text,'search-boost'))
  assert.equal(updated.mcp_servers['search-boost'].command,'new')
  assert.deepEqual(updated.mcp_servers.other,original.mcp_servers.other)
  assert.equal(updated.note,original.note)
  assert.deepEqual(removed.mcp_servers.other,original.mcp_servers.other)
  assert.equal(removed.mcp_servers['search-boost'],undefined)
}
console.log('ok: both string scanners consume legal 3/4/5 quote endings; real subsequent declarations cannot be hidden and unrelated sibling strings remain editable')
for(const q of ['"',"'"]) {
  for(const count of [6,7,8]) {
    const text=`note=${q.repeat(count)}\n[mcp_servers.search-boost]\ncommand="old"\nargs=[\n${q.repeat(3)}argument${q.repeat(4)}\n]\n`
    const original=parse(text)
    const updated=parse(upsertTomlSection(text,'search-boost','command="new"\nargs=[]'))
    assert.equal(updated.note,original.note)
    assert.deepEqual(updated.mcp_servers['search-boost'].args,[])
    assert.equal(parse(removeTomlSection(text,'search-boost')).note,original.note)
  }
  const invalid=`note=${q.repeat(9)}\n[mcp_servers.search-boost]\ncommand="node"\nargs=[]\n`
  assert.throws(()=>parse(invalid),'independent parser must reject the invalid quote run')
  assert.throws(()=>upsertTomlSection(invalid,'search-boost','command="new"'),/Malformed TOML string; left unchanged/)
  assert.throws(()=>removeTomlSection(invalid,'search-boost'),/Malformed TOML string; left unchanged/)
  write(PATHS.codex.config,invalid)
  const roots=[join(process.env.HOME,'.codex'),join(process.env.HOME,'.agents')], before=roots.map(snapshot)
  for(const verb of ['install','uninstall']) {
    const result=run(verb,'-t','codex','-y','--keep-native')
    assert.equal(result.status,1,result.stderr+result.stdout)
    assert.match(result.stdout+result.stderr,/Malformed TOML string; left unchanged/)
    assert.deepEqual(roots.map(snapshot),before)
  }
}
console.log('ok: compact legal 6/7/8-quote values and multiline array arguments work; invalid 9-quote values fail closed before any public CLI asset mutation')
