import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { configReadCandidates, configWritePath } from '../../config-paths.mjs'
import { ENV_MAP, KEY_NAMES, keysFilePath, readKeysFile } from '../../keys.mjs'
import { getLayer, layerFileExists, layerFilePath } from '../../layer-config.mjs'
import { layerApiNoKeysWarning } from '../../installer/status.mjs'

function readLayerFileRaw() {
  for (const file of configReadCandidates('layer')) {
    if (!existsSync(file)) continue
    try {
      return { file, raw: readFileSync(file, 'utf8'), parsed: JSON.parse(readFileSync(file, 'utf8')) }
    } catch (err) {
      return { file, raw: null, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return null
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkLayerConfigValid(_ctx) {
  const layerFile = readLayerFileRaw()
  if (layerFile?.error) {
    return {
      id: 'layer_config_valid',
      category: 'config',
      status: 'fail',
      message: `Layer file invalid JSON (${layerFile.file})`,
      fix_hint: 'search-boost config layer --layer free|api',
      details: { file: layerFile.file, error: layerFile.error },
    }
  }
  if (layerFile?.parsed?.layer === 'free' || layerFile?.parsed?.layer === 'api') {
    return {
      id: 'layer_config_valid',
      category: 'config',
      status: 'pass',
      message: `layer=${layerFile.parsed.layer} (${layerFile.file})`,
      details: { layer: layerFile.parsed.layer, file: layerFile.file },
    }
  }
  if (!layerFileExists() && (process.env.SEARCH_BOOST_LAYER === 'free' || process.env.SEARCH_BOOST_LAYER === 'api')) {
    return {
      id: 'layer_config_valid',
      category: 'config',
      status: 'warn',
      message: `Layer from env SEARCH_BOOST_LAYER=${process.env.SEARCH_BOOST_LAYER} (no file)`,
      fix_hint: 'search-boost config layer --layer free|api',
      details: { layer: process.env.SEARCH_BOOST_LAYER, source: 'env' },
    }
  }
  const layer = getLayer()
  return {
    id: 'layer_config_valid',
    category: 'config',
    status: 'pass',
    message: `layer=${layer}${layerFile ? ` (${layerFile.file})` : ' (inferred)'}`,
    details: { layer, file: layerFile?.file ?? null },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkLayerKeysCoherence(_ctx) {
  const layer = getLayer()
  const warn = layerApiNoKeysWarning()
  if (warn) {
    return {
      id: 'layer_keys_coherence',
      category: 'config',
      status: 'warn',
      message: 'api layer but no API keys configured',
      fix_hint: 'search-boost config keys',
      details: { layer, hasAnyKey: false },
    }
  }
  return {
    id: 'layer_keys_coherence',
    category: 'config',
    status: 'pass',
    message: layer === 'api' ? 'api layer with keys configured' : 'free layer (no keys required)',
    details: { layer, hasAnyKey: layer === 'api' },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkKeysFileIntegrity(_ctx) {
  const writePath = keysFilePath()
  const home = homedir()
  const legacyPath = join(home, '.dsh-search-boost-keys.json')
  const primaryHome = join(home, '.search-boost-keys.json')

  if (existsSync(writePath)) {
    try {
      JSON.parse(readFileSync(writePath, 'utf8'))
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'pass',
        message: `Keys file valid (${writePath})`,
        details: { file: writePath },
      }
    } catch (err) {
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'fail',
        message: `Keys file invalid JSON (${writePath})`,
        fix_hint: 'Fix JSON or remove corrupt file; run search-boost config keys',
        details: { file: writePath, error: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  if (!existsSync(primaryHome) && existsSync(legacyPath)) {
    try {
      JSON.parse(readFileSync(legacyPath, 'utf8'))
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'warn',
        message: `Reading keys from legacy ${legacyPath}`,
        fix_hint: 'search-boost config keys (migrate to ~/.search-boost-keys.json)',
        details: { file: legacyPath, legacy: true },
      }
    } catch (err) {
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'fail',
        message: `Legacy keys file invalid JSON (${legacyPath})`,
        fix_hint: 'Fix JSON or migrate with search-boost config keys',
        details: { file: legacyPath, error: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  return {
    id: 'keys_file_integrity',
    category: 'config',
    status: 'pass',
    message: 'No keys file (optional)',
    details: { file: writePath, exists: false },
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkEnvKeyDivergence(_ctx) {
  const fileKeys = readKeysFile()
  /** @type {string[]} */
  const shadowed = []
  for (const name of KEY_NAMES) {
    if (fileKeys[name] && process.env[ENV_MAP[name]]?.trim()) {
      shadowed.push(name)
    }
  }
  if (shadowed.length) {
    return {
      id: 'env_key_divergence',
      category: 'config',
      status: 'warn',
      message: `Env vars shadow file keys: ${shadowed.join(', ')}`,
      fix_hint: 'Unset env var or search-boost config keys --show',
      details: { shadowed },
    }
  }
  return {
    id: 'env_key_divergence',
    category: 'config',
    status: 'pass',
    message: 'No env/file key conflicts',
  }
}

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkConfigPathsWritable(_ctx) {
  const keysPath = configWritePath('keys')
  const layerPath = configWritePath('layer')
  if (process.env.SEARCH_BOOST_KEYS_FILE || process.env.SEARCH_BOOST_LAYER_FILE) {
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'warn',
      message: 'Using SEARCH_BOOST_*_FILE path overrides',
      details: {
        keysFile: process.env.SEARCH_BOOST_KEYS_FILE ?? null,
        layerFile: process.env.SEARCH_BOOST_LAYER_FILE ?? null,
      },
    }
  }
  try {
    accessSync(dirname(keysPath), constants.W_OK)
    accessSync(dirname(layerPath), constants.W_OK)
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'pass',
      message: 'Config directories writable',
      details: { keysDir: dirname(keysPath), layerDir: dirname(layerPath) },
    }
  } catch {
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'fail',
      message: 'Home directory not writable for config files',
      fix_hint: 'Fix permissions or set SEARCH_BOOST_KEYS_FILE',
      details: { keysPath, layerPath },
    }
  }
}
