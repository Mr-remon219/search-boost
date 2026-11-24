#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { searchBoostHome } from '../lib/config-paths.mjs'
import { writeFileAtomicPrivate, withFileLock } from '../lib/private-file.mjs'
import { createCommunityBrowserBridge } from '../lib/community/browser-bridge.mjs'

const port = Number(process.env.SEARCH_BOOST_BROWSER_PORT ?? 19826)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid SEARCH_BOOST_BROWSER_PORT')
const path = join(searchBoostHome(), 'config', 'community-browser-token')
const token = withFileLock(path, () => {
  if (!existsSync(path)) writeFileAtomicPrivate(path, `${randomBytes(32).toString('hex')}\n`)
  return readFileSync(path, 'utf8').trim()
})
const server = createCommunityBrowserBridge({ token })
server.listen(port, '127.0.0.1', () => {
  console.log(`Read-only community bridge: http://127.0.0.1:${port}`)
  console.log(`Private token file (never paste into tool arguments): ${path}`)
  console.log('Load browser/community-bridge manually as an unpacked Chrome extension, configure it, and explicitly enable it.')
})
server.on('error', () => { console.error('Community bridge could not start'); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close() })
