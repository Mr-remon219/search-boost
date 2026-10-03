#!/usr/bin/env node
import './isolate-tests.mjs'
// Regenerate in a disposable copy; never repair the checkout before testing it.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { testRoot } from './isolate-tests.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const copy = join(testRoot, 'generated-copy')
mkdirSync(copy)
for (const file of ['package.json', 'lib', 'agents', 'templates', 'grok-plugin', 'scripts']) cpSync(join(root, file), join(copy, file), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
function snapshot(dir, prefix = '') {
  return Object.fromEntries(readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name
    const stat = lstatSync(path)
    assert(!stat.isSymbolicLink(), `generated asset must be a regular file: ${relative}`)
    return stat.isDirectory() ? Object.entries(snapshot(path, relative)) : [[relative, readFileSync(path).toString('base64')]]
  }))
}
const trees = ['grok-plugin', 'agents/antigravity/plugin']
const before = Object.fromEntries(trees.map(tree => [tree, snapshot(join(copy, tree))]))
for (const script of ['sync-grok-plugin.mjs', 'build-plugin.mjs']) {
  const out = spawnSync(process.execPath, [join(copy, 'scripts', script)], { cwd: copy, env: process.env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(out.status, 0, `${script}: ${out.error?.message ?? ''}\n${out.stdout}\n${out.stderr}`)
}
for (const tree of trees) assert.deepEqual(snapshot(join(copy, tree)), before[tree], `${tree} drift: regenerate explicitly, review and commit the asset diff`)
console.log('ok: Grok and Antigravity assets regenerate byte-for-byte; checkout was not modified')
