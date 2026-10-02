#!/usr/bin/env node
import './isolate-tests.mjs'
// YAML structure checks supplement actionlint; this is not a substitute for its
// GitHub expression/action validation. No workflow code is executed here.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
const root = fileURLToPath(new URL('../', import.meta.url))
export function parseWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true, stringKeys: true })
  assert.equal(document.errors.length, 0, document.errors.map(e => e.message).join('\n'))
  return document.toJS({ maxAliasCount: 100 })
}
export function validateWorkflow(workflow, name = 'workflow') {
  const at = message => `${name}: ${message}`
  assert.equal(workflow.permissions?.contents, 'read', at('token must default to contents: read'))
  assert(Object.values(workflow.permissions).every(value => value === 'read' || value === 'none'), at('no write token in validation'))
  assert(!workflow.on?.pull_request_target && !Object.hasOwn(workflow.on ?? {}, 'pull_request_target'), at('untrusted PRs must not run privileged'))
  assert(!Object.hasOwn(workflow.on ?? {}, 'workflow_run'), at('privileged workflow_run needs a separate security design'))
  assert(!/\$\{\{\s*secrets\./.test(JSON.stringify(workflow)), at('validation must not consume secrets'))
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    assert(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 45, at(`${id}: bounded job timeout required`))
    assert(!job['continue-on-error'], at(`${id}: failures must gate`))
    if (job.permissions) assert(Object.values(job.permissions).every(value => value === 'read' || value === 'none'), at(`${id}: no privileged job token`))
    const steps = job.steps ?? []
    for (const step of steps) {
      assert(!step['continue-on-error'], at(`${id}: failures must not be ignored`))
      if (step.uses && !step.uses.startsWith('./')) {
        assert(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(step.uses), at(`immutable full action SHA required: ${step.uses}`))
        if (step.uses.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false, at('checkout credentials must not persist'))
      }
      if (step.run) {
        assert(!/npm run (?:plugin:sync-grok|build:plugin)/.test(step.run), at('do not repair generated assets before checking them'))
        assert(!/npm run (?:test:(?!isolation\b)\S+|smoke)\b|node scripts\/(?:test-|smoke\.|ci-doctor-smoke)/.test(step.run), at('named suites duplicate the isolation owner'))
        if (/npm run test:isolation/.test(step.run)) assert(!step.if, at('regressions require normal fail-closed prerequisites'))
      }
    }
    if (steps.some(step => /npm run test:isolation/.test(step.run ?? ''))) {
      assert.equal(steps.filter(step => /npm run test:isolation/.test(step.run ?? '')).length, 1, at(`${id}: exactly one regression owner`))
      assert.equal(job.strategy?.['fail-fast'], false, at('platform failures must remain independent'))
    }
  }
}
export function checkRepositoryWorkflows() {
  const dir = join(root, '.github', 'workflows')
  const files = readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).sort()
  assert(files.length > 0, 'at least one workflow is required')
  for (const file of files) validateWorkflow(parseWorkflow(readFileSync(join(dir, file), 'utf8')), file)
  const ci = parseWorkflow(readFileSync(join(dir, 'ci.yml'), 'utf8'))
  const cells = ci.jobs.test.strategy.matrix.include
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const floor = pkg.engines.node.match(/^>=(\d+)\.(\d+)(?:\.(\d+))?$/)
  assert(floor, 'update CI floor validation when changing the supported Node expression')
  const minimum = `${floor[1]}.${floor[2]}.${floor[3] ?? '0'}`
  assert(cells.some(cell => cell.os === 'ubuntu-latest' && cell.node === minimum), 'declared minimum Node must be tested')
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) assert(cells.some(cell => cell.os === os && cell.label === os), `preserve required check test (${os})`)
  assert(cells.some(cell => cell.os === 'ubuntu-latest' && cell.node === '24'), 'current supported Node 24 must be tested')
  assert.equal(cells.filter(cell => cell.primary === true).length, 1, 'static/audit obligations have one primary owner')
  assert.equal(new Set(cells.map(cell => `${cell.os}:${cell.node}`)).size, cells.length, 'matrix cells must not duplicate')
  console.log(`ok: ${files.length} parsed workflow(s), immutable actions, read-only token, one regression owner, platform/Node obligations`)
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) checkRepositoryWorkflows()
