import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { PKG_ROOT } from '../../pkg.mjs'

const require = createRequire(import.meta.url)

/** @param {import('../types.mjs').DoctorContext} _ctx */
export function checkNodeVersion(_ctx) {
  const pkg = require(join(PKG_ROOT, 'package.json'))
  const engines = String(pkg.engines?.node ?? '>=22.13')
  // Accept plain and compound ranges (>=x.y, ^x.y, x.y, "^x || >=y"): compare
  // against the first version token instead of assuming a bare ">=" prefix.
  const match = engines.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  const minMajor = Number(match?.[1] ?? 0)
  const minMinor = Number(match?.[2] ?? 0)
  const min = match ? `${match[1]}.${match[2] ?? '0'}` : engines
  const [curMajor, curMinor = '0'] = process.versions.node.split('.')
  const ok =
    Number(curMajor) > minMajor
    || (Number(curMajor) === minMajor && Number(curMinor) >= minMinor)
  if (ok) {
    return {
      id: 'node_version',
      category: 'runtime',
      status: 'pass',
      message: `Node.js ${process.versions.node} (>= ${min})`,
      details: { node: process.versions.node, engines },
    }
  }
  return {
    id: 'node_version',
    category: 'runtime',
    status: 'fail',
    message: `Node.js ${process.versions.node} below minimum ${min}`,
    fix_hint: 'Upgrade Node: https://nodejs.org/',
    details: { node: process.versions.node, engines },
  }
}
