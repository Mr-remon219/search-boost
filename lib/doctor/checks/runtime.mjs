import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { PKG_ROOT } from '../../pkg.mjs'

const require = createRequire(import.meta.url)

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkNodeVersion(_ctx) {
  const pkg = require(join(PKG_ROOT, 'package.json'))
  const min = String(pkg.engines?.node ?? '>=22.13').replace(/^>=/, '')
  const [minMajor, minMinor = '0'] = min.split('.')
  const [curMajor, curMinor = '0'] = process.versions.node.split('.')
  const ok =
    Number(curMajor) > Number(minMajor)
    || (Number(curMajor) === Number(minMajor) && Number(curMinor) >= Number(minMinor))
  if (ok) {
    return {
      id: 'node_version',
      category: 'runtime',
      status: 'pass',
      message: `Node.js ${process.versions.node} (>= ${min})`,
      details: { node: process.versions.node, minimum: min },
    }
  }
  return {
    id: 'node_version',
    category: 'runtime',
    status: 'fail',
    message: `Node.js ${process.versions.node} below minimum ${min}`,
    fix_hint: 'Upgrade Node: https://nodejs.org/',
    details: { node: process.versions.node, minimum: min },
  }
}
