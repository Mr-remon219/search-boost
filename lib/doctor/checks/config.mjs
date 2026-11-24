import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  configFlatPath,
  configLayoutPaths,
  configLegacyPath,
  configNestedPath,
  configReadCandidates,
  configWritePath,
  searchBoostHome,
} from '../../config-paths.mjs'
import { CONFIG_KEY_NAMES, ENV_MAP, readKeysFile, readKeysRouting } from '../../keys.mjs'
import { getLayer, layerFileExists, layerFilePath } from '../../layer-config.mjs'

function readLayerFileRaw() {
  for (const file of configReadCandidates('layer')) {
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, 'utf8')
      return { file, raw, parsed: JSON.parse(raw) }
    } catch (err) {
      return { file, raw: null, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return null
}

/** @param {string} path */
function isWritable(path) {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Existing, writable directory. @param {string} path */
function isWritableDir(path) {
  try {
    return statSync(path).isDirectory() && isWritable(path)
  } catch {
    return false
  }
}

/** Nearest existing ancestor of a (possibly missing) path, or null. @param {string} path */
function nearestExistingAncestor(path) {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
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
  if (layerFile && !layerFile.error) {
    // Present but unusable: getLayer() silently skips it, so report it instead
    // of falling through to an inferred layer.
    return {
      id: 'layer_config_valid',
      category: 'config',
      status: 'warn',
      message: `Layer file has no usable layer value (${layerFile.file})`,
      fix_hint: 'search-boost config layer --layer free|api',
      details: { file: layerFile.file, parsed: layerFile.parsed ?? null },
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
  try {
    const { summary } = readKeysRouting()
    return {
      id: 'layer_keys_coherence', category: 'config', status: 'pass',
      message: summary.enabled ? `Automatic API selection (${summary.enabledNames.join(', ')}) — one engine is enough` : 'Automatic keyless search (no enabled API key)',
      details: { layer: summary.enabled ? 'api' : 'free', hasAnyKey: summary.configured > 0, configured: summary.configured, enabled: summary.enabled, enabledNames: summary.enabledNames },
    }
  } catch (err) {
    return {
      id: 'layer_keys_coherence', category: 'config', status: 'fail',
      message: 'cannot evaluate engine routing: keys configuration unreadable',
      fix_hint: 'Fix the keys file; run search-boost config keys',
      details: { code: err?.code ?? null },
    }
  }
}

/** @param {import('../types.mjs').DoctorContext} ctx */
export function checkKeysFileIntegrity(ctx) {
  const options = ctx.homeDir ? { homeDir: ctx.homeDir } : {}
  const writePath = configWritePath('keys', options)
  const nested = configNestedPath('keys', options)
  const flat = configFlatPath('keys', options)
  const legacy = configLegacyPath('keys', options)

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

  if (!existsSync(nested) && !existsSync(flat) && legacy && existsSync(legacy)) {
    try {
      JSON.parse(readFileSync(legacy, 'utf8'))
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'warn',
        message: `Reading keys from legacy ${legacy}`,
        fix_hint: 'search-boost config keys (migrate to ~/.search-boost/config/keys.json)',
        details: { file: legacy, legacy: true },
      }
    } catch (err) {
      return {
        id: 'keys_file_integrity',
        category: 'config',
        status: 'fail',
        message: `Legacy keys file invalid JSON (${legacy})`,
        fix_hint: 'Fix JSON or migrate with search-boost config keys',
        details: { file: legacy, error: err instanceof Error ? err.message : String(err) },
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
  // Every key slot, including stored-only engines: an env var that silently
  // shadows a stored key is worth reporting even before the adapter exists.
  for (const name of CONFIG_KEY_NAMES) {
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

/** @param {import('../types.mjs').DoctorContext} ctx */
export function checkConfigLayout(ctx) {
  const options = ctx.homeDir ? { homeDir: ctx.homeDir } : {}
  const hasEnvOverride = !!(
    process.env.SEARCH_BOOST_KEYS_FILE
    || process.env.SEARCH_BOOST_LAYER_FILE
    || process.env.SEARCH_BOOST_XAUTH_FILE
    || process.env.SEARCH_BOOST_XGUEST_FILE
    || process.env.SEARCH_BOOST_WORKSPACES_FILE
  )
  if (hasEnvOverride) {
    return {
      id: 'config_layout',
      category: 'config',
      status: 'pass',
      message: 'Config layout via SEARCH_BOOST_*_FILE overrides',
      details: { layout: 'env-override' },
    }
  }

  /** @type {string[]} */
  const flatOnly = []
  for (const kind of ['keys', 'layer', 'xauth', 'xguest', 'workspaces']) {
    const { nested, flat } = configLayoutPaths(kind, options)
    if (existsSync(flat) && !existsSync(nested)) flatOnly.push(kind)
  }

  const home = searchBoostHome(options)
  const nestedInUse = ['keys', 'layer'].some((kind) => existsSync(configNestedPath(kind, options)))

  if (flatOnly.length) {
    return {
      id: 'config_layout',
      category: 'config',
      status: 'warn',
      message: `Flat config files in ~ (${flatOnly.join(', ')}) — migrate to ${home}/`,
      fix_hint: 'Run any config write (e.g. search-boost config keys) to lazy-migrate to ~/.search-boost/',
      details: { flatOnly, home, nestedInUse },
    }
  }

  return {
    id: 'config_layout',
    category: 'config',
    status: 'pass',
    message: nestedInUse ? `Nested config under ${home}/` : 'No config files yet (defaults apply)',
    details: { home, nestedInUse },
  }
}

/** @param {import('../types.mjs').DoctorContext} ctx */
export function checkConfigPathsWritable(ctx) {
  const options = ctx.homeDir ? { homeDir: ctx.homeDir } : {}
  const usingOverrides = !!(
    process.env.SEARCH_BOOST_KEYS_FILE
    || process.env.SEARCH_BOOST_LAYER_FILE
    || process.env.SEARCH_BOOST_XAUTH_FILE
    || process.env.SEARCH_BOOST_XGUEST_FILE
    || process.env.SEARCH_BOOST_WORKSPACES_FILE
  )

  if (usingOverrides) {
    const keysPath = configWritePath('keys', options)
    const layerPath = configWritePath('layer', options)
    const keysAnchor = nearestExistingAncestor(dirname(keysPath))
    const layerAnchor = nearestExistingAncestor(dirname(layerPath))
    // Missing parent dirs are created on write (ensurePrivateDir), so only the
    // nearest existing ancestor has to be writable.
    if (keysAnchor && isWritableDir(keysAnchor) && layerAnchor && isWritableDir(layerAnchor)) {
      return {
        id: 'config_paths_writable',
        category: 'config',
        status: 'pass',
        message: 'Config path overrides writable',
        details: {
          keysFile: process.env.SEARCH_BOOST_KEYS_FILE ?? null,
          layerFile: process.env.SEARCH_BOOST_LAYER_FILE ?? null,
          keysAnchor,
          layerAnchor,
        },
      }
    }
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'fail',
      message: 'SEARCH_BOOST_*_FILE path not writable',
      fix_hint: 'Fix permissions on override paths or unset SEARCH_BOOST_*_FILE',
      details: { keysPath, layerPath, keysAnchor, layerAnchor },
    }
  }

  const home = searchBoostHome(options)
  const dirs = [
    join(home, 'config'),
    join(home, 'cache'),
    join(home, 'state'),
  ]
  const blocked = dirs.find((dir) => existsSync(dir) && !isWritableDir(dir))
  if (blocked) {
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'fail',
      message: `Config directory not writable (${blocked})`,
      fix_hint: 'Fix permissions on ~/.search-boost/ or set SEARCH_BOOST_HOME / SEARCH_BOOST_*_FILE',
      details: { home, dirs, blocked },
    }
  }
  if (dirs.every(isWritableDir)) {
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'pass',
      message: 'Config directories writable (~/.search-boost/{config,cache,state})',
      details: { home, dirs },
    }
  }
  const anchor = nearestExistingAncestor(home)
  if (anchor && isWritableDir(anchor)) {
    return {
      id: 'config_paths_writable',
      category: 'config',
      status: 'pass',
      message: 'Home writable (nested dirs created on first write)',
      details: { home, parent: anchor, dirs },
    }
  }
  return {
    id: 'config_paths_writable',
    category: 'config',
    status: 'fail',
    message: 'Home directory not writable for ~/.search-boost/',
    fix_hint: 'Fix permissions or set SEARCH_BOOST_HOME / SEARCH_BOOST_*_FILE',
    details: { home, dirs, parent: anchor },
  }
}
