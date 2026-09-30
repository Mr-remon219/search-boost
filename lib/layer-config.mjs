import { t } from './installer/i18n.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { configNestedPath, configReadCandidates, configWritePath, prepareConfigWrite } from './config-paths.mjs'
import { withFileLock, writeFileAtomicPrivate } from './private-file.mjs'
import { hasAnyKey } from './keys.mjs'

export function layerFilePath() {
  return configWritePath('layer')
}

export function layerFileExists() {
  return configReadCandidates('layer').some((f) => existsSync(f))
}

/** @returns {'free'|'api'|null} */
export function layerEnvOverride() {
  const v = process.env.SEARCH_BOOST_LAYER
  return v === 'free' || v === 'api' ? v : null
}

/** Whether non-interactive install may persist a default free layer file. */
export function shouldPersistDefaultLayer() {
  return !layerFileExists() && !layerEnvOverride() && !hasAnyKey()
}

/** @returns {'free'|'api'} */
export function getLayer() {
  for (const file of configReadCandidates('layer')) {
    try {
      if (!existsSync(file)) continue
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw?.layer === 'free' || raw?.layer === 'api') return raw.layer
    } catch { /* try next */ }
  }
  if (process.env.SEARCH_BOOST_LAYER === 'free' || process.env.SEARCH_BOOST_LAYER === 'api') {
    return process.env.SEARCH_BOOST_LAYER
  }
  return hasAnyKey() ? 'api' : 'free'
}

/** @param {{ detailed?: boolean, hasKeys?: boolean }} [opts] */
export function layerSelectOptions(opts = {}) {
  if (opts.detailed) {
    return [
      { value: 'free', label: t('free — keyless engines (bing, ddg, yahoo, exa-free)', "free — 无需 Key 的引擎（bing, ddg, yahoo, exa-free）") },
      {
        value: 'api',
        label: t('api — full pool incl. keyed tavily/brave/exa', "api — 完整引擎池，含有 Key 的 tavily/brave/exa"),
        hint: opts.hasKeys ? t('keys detected', "已检测到 Key") : t('needs ≥1 key (all recommended)', "需要至少一个 Key（建议配置更多引擎）"),
      },
    ]
  }
  return [
    { value: 'free', label: t('free — keyless engines only', "free — 仅使用无需 Key 的引擎") },
    { value: 'api', label: t('api — keyed APIs when configured (≥1 key; all recommended)', "api — 优先使用已配置 Key 的 API（至少一个 Key；建议配置更多引擎）") },
  ]
}

/** @param {'free'|'api'} layer */
export function setLayer(layer) {
  if (layer !== 'free' && layer !== 'api') throw new Error(`Invalid layer: ${layer}`)
  const file = layerFilePath()
  const tightenDir = file === configNestedPath('layer')
  return withFileLock(file, () => {
    // Migration and replacement belong to the same writer critical section.
    prepareConfigWrite('layer')
    writeFileAtomicPrivate(file, `${JSON.stringify({ layer }, null, 2)}\n`, { tightenDir })
    return layer
  }, { tightenDir, waitMs: 5000 })
}
