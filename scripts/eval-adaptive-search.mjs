#!/usr/bin/env node
/**
 * adaptive_search evaluation harness — OPT-IN, REAL NETWORK, NEVER in CI.
 *
 *   node scripts/eval-adaptive-search.mjs --yes --arm both
 *   node scripts/eval-adaptive-search.mjs --yes --arm adaptive --out eval-adaptive.json
 *   node scripts/eval-adaptive-search.mjs --yes --arm baseline --questions my-8-12.json
 *
 * What it measures (per question):
 *   * whether a worth-reading fragment exists (adaptive: useful_result
 *     evidence; baseline: a fetchable result or a result already carrying text)
 *   * what the adaptive loop claimed (keyword search satisfaction) so a human can judge false
 *     positives and false negatives against the BASELINE material
 *   * request volume: search calls, internal engine requests, page fetches,
 *     Jev calls / HTTP attempts / input tokens, wall-clock time
 *
 * Fairness rules baked in:
 *   * Exactly one question per adaptive call — the 8–12-question suite is
 *     evaluated as independent calls, and the group sizes are reported
 *   * run each arm in its own process (`--arm adaptive` / `--arm baseline`) so the
 *     6h search cache and the 24h page cache do not leak between arms
 *   * Jev's own probabilities are NEVER used as evidence that Jev is better: the
 *     report only prints them for a human/independent rubric to compare against
 *     the retrieved material. Reading value must be judged independently against the task.
 *
 * The script therefore prints a rubric worksheet and a metrics table, and writes
 * the same data as JSON for an independent reviewer.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { runAdaptiveSearch, runFused, runFetchPage, collectSearchStats } from '../lib/runtime.mjs'
import { readJevConfig, jevStatus } from '../lib/jev-config.mjs'
import { DEFAULT_EVAL_QUESTIONS } from './eval-questions.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}

if (flag('--help') || !(flag('--yes') || process.env.EVAL_ADAPTIVE === '1')) {
  console.log([
    'adaptive_search evaluation (explicit opt-in, real searches + real Jev calls).',
    '',
    '  node scripts/eval-adaptive-search.mjs --yes --arm both [--questions file.json] [--out report.json]',
    '',
    '  --arm adaptive|baseline|both   run one arm (preferred: separate processes) or both',
    '  --questions <file>             8–12 questions as a JSON string array (default: built-in set)',
    '  --out <file>                   also write the JSON report',
    '',
    'This makes real, billed requests (Jev input tokens; Tavily/Exa quota) and real',
    'page fetches. It never prints credentials. Judge the outcome yourself: the script',
    'reports both arms side by side and prints a rubric worksheet — Jev scores are',
    'reported as model judgements, not as measured accuracy.',
  ].join('\n'))
  process.exit(0)
}

const GROUP_SIZE = 1 // current public contract: exactly one coherent question

const questions = (() => {
  const file = option('--questions')
  if (!file) return DEFAULT_EVAL_QUESTIONS
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed) || parsed.some((q) => typeof q !== 'string' || !q.trim())) {
    console.error('eval: --questions must point to a JSON array of non-empty strings')
    process.exit(1)
  }
  return parsed
})()

if (questions.length < 8 || questions.length > 12) {
  console.error(`eval: expected 8–12 questions, received ${questions.length}`)
  process.exit(1)
}
if (questions.some((q) => q.length > 400)) {
  console.error('eval: every question must be ≤400 characters (the adaptive_search limit)')
  process.exit(1)
}

const groups = []
for (let index = 0; index < questions.length; index += GROUP_SIZE) groups.push(questions.slice(index, index + GROUP_SIZE))

const arm = option('--arm', 'both')
const outFile = option('--out')
const report = {
  startedAt: new Date().toISOString(),
  layer: collectSearchStats().layer,
  jevConfigured: jevStatus().configured,
  jevGateway: readJevConfig().baseUrlStored ? 'custom' : 'default',
  questions,
  groupSizes: groups.map((group) => group.length),
  arm,
  adaptive: [],
  baseline: [],
  limitations: [
    'Judging reading value requires independent review of returned material; this script does not score correctness.',
    'Retrieval satisfaction is a heuristic code-side stopping rule over model-scored material, not semantic review, measured accuracy or answer completeness.',
    'Cache state differs between runs and arms; run arms in separate processes for comparability.',
  ],
}

async function runAdaptiveArm() {
  for (const [index, group] of groups.entries()) {
    const started = Date.now()
    const result = await runAdaptiveSearch({ questions: group }, { host: 'mcp', diagnostics: true })
    if (result.stopReason === 'invalid_input') throw new Error('eval: adaptive input was rejected; this is a harness error, not an unsuccessful search')
    report.adaptive.push({
      group: index + 1,
      size: group.length,
      tookMs: Date.now() - started,
      stopReason: result.stopReason,
      rounds: result.rounds,
      convergence: result.convergence ?? null,
      usage: result.usage,
      jev: {
        used: result.jev.used,
        degraded: result.jev.degraded,
        calls: result.jev.calls,
        httpAttempts: result.jev.httpAttempts,
        inputTokens: result.jev.inputTokens,
        inputTokensEstimated: result.jev.inputTokensEstimated,
      },
      perQuestion: result.questions.map((q) => ({
        id: q.id,
        question: q.question,
        status: q.status,
        assessed: q.assessed,
        retrievalSufficient: q.retrievalSufficient === true,
        basis: [...new Set(q.evidence.map(item => item.textBasis))].join(', '),
        reasons: q.uncoveredReasons,
        usefulResults: q.usefulResults ?? 0,
        keywordProgress: q.keywordProgress ?? [],
        evidenceCount: q.evidenceCount,
        topEvidence: q.evidence.slice(0, 3).map((item) => ({ evidenceId: item.evidenceId, url: item.url, basis: item.textBasis, status: item.status, reviewedText: String(item.reviewedText ?? '').slice(0, 400) })),
      })),
    })
  }
}

async function runBaselineArm() {
  for (const question of questions) {
    const started = Date.now()
    const searchCalls = 1
    let fetchCalls = 0
    const fused = await runFused({ query: question, complexity: 'medium', maxResults: 6 })
    const usableInline = fused.results.filter((hit) => typeof hit.content === 'string' && hit.content.trim().split(/\s+/).length >= 300)
    let fetched = null
    if (usableInline.length === 0 && fused.results.length > 0) {
      // One fetch when no result carried usable text — the baseline rule the core
      // docs describe ("fetch decisive sources when snippets are not enough").
      try {
        fetched = await runFetchPage(fused.results[0].url, question)
        fetchCalls++
      } catch (err) {
        fetched = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    report.baseline.push({
      question,
      tookMs: Date.now() - started,
      searchCalls,
      fetchCalls,
      results: fused.results.length,
      enginesUsed: fused.enginesUsed,
      engineRequests: Object.values(fused.engineStats ?? {}).reduce((sum, stat) => sum + (stat.attempts ?? 0), 0),
      inlineUsable: usableInline.length,
      topResults: fused.results.slice(0, 3).map((hit) => ({ url: hit.url, snippet: String(hit.snippet ?? '').slice(0, 400) })),
      fetchedWords: fetched?.word_count ?? null,
      fetchedText: typeof fetched?.content === 'string' ? fetched.content.slice(0, 400) : null,
      fetchError: fetched?.error ?? null,
    })
  }
}

if (arm === 'adaptive' || arm === 'both') await runAdaptiveArm()
if (arm === 'baseline' || arm === 'both') await runBaselineArm()

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0)
const adaptiveTotals = {
  searchCalls: sum(report.adaptive.map((entry) => entry.usage?.searchCalls)),
  engineRequests: sum(report.adaptive.map((entry) => entry.usage?.engineRequests)),
  fetchCalls: sum(report.adaptive.map((entry) => entry.usage?.fetchCalls)),
  jevCalls: sum(report.adaptive.map((entry) => entry.jev?.calls)),
  jevHttpAttempts: sum(report.adaptive.map((entry) => entry.jev?.httpAttempts)),
  jevInputTokens: sum(report.adaptive.map((entry) => entry.jev?.inputTokens)),
  jevInputTokensEstimated: sum(report.adaptive.map((entry) => entry.jev?.inputTokensEstimated)),
  tookMs: sum(report.adaptive.map((entry) => entry.tookMs)),
  satisfied: report.adaptive.flatMap((entry) => entry.perQuestion).filter((q) => q.retrievalSufficient).length,
}
const baselineTotals = {
  searchCalls: sum(report.baseline.map((entry) => entry.searchCalls)),
  engineRequests: sum(report.baseline.map((entry) => entry.engineRequests)),
  fetchCalls: sum(report.baseline.map((entry) => entry.fetchCalls)),
  tookMs: sum(report.baseline.map((entry) => entry.tookMs)),
}
report.totals = { adaptive: adaptiveTotals, baseline: baselineTotals, questions: questions.length, groups: groups.length }

const lines = []
lines.push(`# adaptive_search evaluation — ${report.startedAt}`)
lines.push('')
lines.push(`layer: ${report.layer}; Jev: ${report.jevConfigured ? `configured (${report.jevGateway} gateway)` : 'NOT configured'}; arm(s): ${arm}`)
lines.push(`questions: ${questions.length} in ${groups.length} adaptive call(s) of ≤${GROUP_SIZE} (group sizes: ${report.groupSizes.join(', ')})`)
lines.push('')
lines.push('## Request volume and time')
lines.push('')
lines.push('| metric | adaptive | baseline (core tools) |')
lines.push('| --- | --- | --- |')
lines.push(`| fused_search calls | ${adaptiveTotals.searchCalls} | ${baselineTotals.searchCalls} |`)
lines.push(`| internal engine requests | ${adaptiveTotals.engineRequests} | ${baselineTotals.engineRequests} |`)
lines.push(`| page fetches | ${adaptiveTotals.fetchCalls} | ${baselineTotals.fetchCalls} |`)
lines.push(`| Jev calls / HTTP attempts | ${adaptiveTotals.jevCalls} / ${adaptiveTotals.jevHttpAttempts} | n/a |`)
lines.push(`| Jev input tokens (server / estimated) | ${adaptiveTotals.jevInputTokens} / ${adaptiveTotals.jevInputTokensEstimated} | n/a |`)
lines.push(`| wall clock (sum of calls) | ${adaptiveTotals.tookMs} ms | ${baselineTotals.tookMs} ms |`)
lines.push('')
lines.push(`Adaptive reported search satisfied: ${adaptiveTotals.satisfied}/${questions.length} question(s). This is the CODE-SIDE heuristic stopping rule over model-scored material — NOT semantic review, verified facts or proof this tool is better.`)
lines.push('')
lines.push('## Rubric worksheet (fill in by reading the sources)')
lines.push('')
lines.push('| # | question | adaptive status | retrieval threshold met (heuristic) | preview basis | useful results | baseline results / fetched words | worth reading? (human) | key source missed? | duplicate rate |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
const adaptiveFlat = report.adaptive.flatMap((entry) => entry.perQuestion)
questions.forEach((question, index) => {
  const adaptive = adaptiveFlat[index]
  const baseline = report.baseline[index]
  lines.push(`| ${index + 1} | ${question.replace(/\|/g, '/').slice(0, 90)} | ${adaptive?.status ?? '—'} | ${adaptive?.retrievalSufficient ?? '—'} | ${adaptive?.basis ?? '—'} | ${adaptive?.usefulResults ?? '—'} | ${baseline ? `${baseline.results} / ${baseline.fetchedWords ?? '—'}` : '—'} | | | |`)
})
lines.push('')
lines.push('## How to reach a conclusion')
lines.push('')
lines.push('1. For each question, independently judge result reading value, intent usefulness (including counterevidence), and credible leads, not whether snippets completely answer it.')
lines.push('2. Measure useful-result rate, missed key sources, duplicate rate, and premature search satisfaction; do not treat search satisfaction as an answer-correctness claim.')
lines.push('3. Compare request volume and time above; a tie is a valid outcome ("no gain, more expensive" is a reportable result).')
lines.push('4. Judge in Chinese/English buckets if the set mixes languages; a mixed score hides per-language behaviour.')
lines.push('')
lines.push('Only the human/independent rubric decides whether adaptive_search is better. Jev probabilities are inputs to that review, not evidence for it.')

const text = lines.join('\n')
console.log(text)
if (outFile) {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\nJSON report written to ${outFile}`)
}
