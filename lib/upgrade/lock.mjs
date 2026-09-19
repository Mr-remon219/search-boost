/** Shared upgrade/migration lock, including verified child-process handoff. */
import { mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { searchBoostHome } from '../config-paths.mjs'
import { strictJson } from './config.mjs'

export async function acquireLock() {
  const path = join(searchBoostHome(), 'state', 'upgrade.lock')
  await mkdir(join(searchBoostHome(), 'state'), { recursive: true })
  const inherited = process.env.SEARCH_BOOST_UPGRADE_HANDOFF
  if (inherited) {
    const lock = await strictJson(path)
    if (lock.token !== inherited) throw new Error('Invalid upgrade handoff; refusing concurrent migration')
    await writeFile(path, JSON.stringify({ pid: process.pid, token: inherited }), { mode: 0o600 })
    return { token: inherited, release: async () => {} }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      const token = randomUUID()
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
      await handle.close()
      return { token, release: async () => {
        const current = await strictJson(path)
        if (current.token !== token) throw new Error('Upgrade lock ownership changed; refusing to remove it')
        if (current.pid !== process.pid) {
          try { process.kill(current.pid, 0); return } catch (err) { if (err.code !== 'ESRCH') return }
        }
        // A timed-out npm parent may leave its cached worker alive. Keep that
        // worker's lock until it exits, rather than admitting a concurrent update.
        await unlink(path)
      } }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const lock = await strictJson(path)
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error(`Invalid upgrade lock: ${path}`)
      try { process.kill(lock.pid, 0) } catch (err) {
        if (err.code === 'ESRCH') { await unlink(path); continue }
      }
      throw new Error('Another upgrade is running; wait for it to finish')
    }
  }
  throw new Error('Cannot acquire upgrade lock')
}

