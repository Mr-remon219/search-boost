import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { configReadCandidates, configWritePath } from './config-paths.mjs'
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
      { value: 'free', label: 'free — keyless engines (bing, ddg, yahoo, exa-free)' },
      {
        value: 'api',
        label: 'api — full pool incl. keyed tavily/brave/exa',
        hint: opts.hasKeys ? 'keys detected' : 'needs ≥1 key (all recommended)',
      },
    ]
  }
  return [
    { value: 'free', label: 'free — keyless engines only' },
    { value: 'api', label: 'api — keyed APIs when configured (≥1 key; all recommended)' },
  ]
}

/** @param {'free'|'api'} layer */
export function setLayer(layer) {
  if (layer !== 'free' && layer !== 'api') throw new Error(`Invalid layer: ${layer}`)
  const file = layerFilePath()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ layer }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return layer
}
