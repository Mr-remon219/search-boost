import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasAnyKey } from './keys.mjs'

export function layerFilePath() {
  return process.env.SEARCH_BOOST_LAYER_FILE ?? join(homedir(), '.dsh-search-boost-layer.json')
}

/** @returns {'free'|'api'} */
export function getLayer() {
  if (process.env.SEARCH_BOOST_LAYER === 'free' || process.env.SEARCH_BOOST_LAYER === 'api') {
    return process.env.SEARCH_BOOST_LAYER
  }
  try {
    if (existsSync(layerFilePath())) {
      const raw = JSON.parse(readFileSync(layerFilePath(), 'utf8'))
      if (raw?.layer === 'free' || raw?.layer === 'api') return raw.layer
    }
  } catch { /* default */ }
  return hasAnyKey() ? 'api' : 'free'
}

/** @param {{ detailed?: boolean, hasKeys?: boolean }} [opts] */
export function layerSelectOptions(opts = {}) {
  if (opts.detailed) {
    return [
      { value: 'free', label: 'free — keyless engines (bing, exa-free, googlenews, yahoo)' },
      {
        value: 'api',
        label: 'api — full pool incl. keyed tavily/brave/exa',
        hint: opts.hasKeys ? 'keys detected' : 'needs keys',
      },
    ]
  }
  return [
    { value: 'free', label: 'free — keyless engines only' },
    { value: 'api', label: 'api — full pool incl. keyed APIs' },
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
