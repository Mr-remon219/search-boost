import { testRoot } from './isolate-tests.mjs'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = '/workspace'
const prefix = join(testRoot, 'prefix')
const home = process.env.HOME
process.env.npm_config_prefix = prefix
process.env.PATH = `${join(prefix, 'bin')}:${process.env.PATH}`

function run(cmd, args, cwd = repo) {
  return execFileSync(cmd, args, { cwd, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

mkdirSync(prefix, { recursive: true })
const betaPack = join('/tmp', run('npm', ['pack', '--pack-destination', '/tmp']).trim().split('\n').at(-1))
run('npm', ['install', '--global', '--prefix', prefix, betaPack])
const betaVersion = run('search-boost', ['--version']).trim()
if (betaVersion !== '0.3.1-beta.4') throw new Error(`beta binary printed ${betaVersion}`)

const secret = 'fixture-doc-backup-key'
run('search-boost', ['config', 'keys', '--set', `brave=${secret}`, '--engines', 'brave,deepseek-search', '--base-url', 'brave=https://fixture-gateway.example/brave', '--base-url', 'deepseek-search=https://api.deepseek.com'])
const beforeShow = run('search-boost', ['config', 'keys', '--show'])
if (beforeShow.includes(secret)) throw new Error('config keys --show printed the raw fixture key')
const fileLine = beforeShow.split('\n').map((line) => line.startsWith('File: ') ? line.slice(6) : line.startsWith('文件：') ? line.slice(3) : '').find(Boolean)
if (!fileLine) throw new Error('config keys --show did not print a File line')
const earlyKeys = fileLine.startsWith('~/') ? join(home, fileLine.slice(2)) : fileLine
const stored = JSON.parse(readFileSync(earlyKeys, 'utf8'))
if (stored.baseUrls) throw new Error('CLI wrote top-level baseUrls; the product field is engines.<name>.baseUrl')
if (stored.engines?.brave?.baseUrl !== 'https://fixture-gateway.example/brave') throw new Error('CLI did not store engines.brave.baseUrl')
if (stored.engines?.['deepseek-search']?.baseUrl !== 'https://api.deepseek.com') throw new Error('CLI did not store engines.deepseek-search.baseUrl')

const script = `
set -euo pipefail
file_line=$(search-boost config keys --show | sed -n 's/^File: //p; s/^文件：//p' | head -n 1)
case "$file_line" in
  '~'/*) keys="\${HOME}/\${file_line#\\~/}" ;;
  *) keys="$file_line" ;;
esac
test -f "$keys"
store=$(dirname -- "$keys")
root=$(dirname -- "$store")
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p -- "$HOME/search-boost-backups"
chmod 700 "$HOME/search-boost-backups"
dest="$HOME/search-boost-backups/store-$stamp"
mkdir -p -- "$dest"
cp -a -- "$root/." "$dest/"
find "$dest" -type d -exec chmod 700 {} +
find "$dest" -type f -exec chmod 600 {} +
cmp -- "$keys" "$dest/config/keys.json"
printf '%s\\n' "$keys" > "$HOME/located-keys-path"
printf '%s\\n' "$dest" > "$HOME/backup-dest"
`
execFileSync('bash', ['-c', script], { env: process.env, encoding: 'utf8' })
const keys = readFileSync(join(home, 'located-keys-path'), 'utf8').trim()
const dest = readFileSync(join(home, 'backup-dest'), 'utf8').trim()
if (!keys.startsWith(`${home}/`)) throw new Error(`located keys path is outside this isolated HOME: ${keys}`)
if (keys.includes('sb-test-') && keys.startsWith('/tmp/')) {
  // The isolated HOME is a temp directory. The documented method still came from config keys --show.
}
if ((statSync(keys).mode & 0o777) !== 0o600) throw new Error('live keys mode is not 0600')
if ((statSync(dest).mode & 0o777) !== 0o700) throw new Error('backup directory mode is not 0700')
if ((statSync(join(dest, 'config', 'keys.json')).mode & 0o777) !== 0o600) throw new Error('backup keys mode is not 0600')
const backupBytes = readFileSync(join(dest, 'config', 'keys.json'))

run('search-boost', ['config', 'keys', '--base-url', 'brave=https://fixture-gateway.example/changed'])
if (readFileSync(keys).equals(backupBytes)) throw new Error('live edit did not change keys')
const failed = `
set -euo pipefail
keys=${JSON.stringify(keys)}
dest=${JSON.stringify(dest)}
cp -a -- "$dest/config/keys.json" "$keys.new"
printf 'damaged' > "$keys.new"
if cmp -- "$dest/config/keys.json" "$keys.new"; then
  echo 'damaged copy compared equal' >&2
  exit 1
fi
rm -f -- "$keys.new"
test ! -e "$keys.new"
`
execFileSync('bash', ['-c', failed], { env: process.env, encoding: 'utf8' })
const liveAfterFailedRestore = readFileSync(keys)
if (liveAfterFailedRestore.equals(backupBytes)) throw new Error('failed restore reverted the live keys file')
const restored = `
set -euo pipefail
keys=${JSON.stringify(keys)}
dest=${JSON.stringify(dest)}
cp -a -- "$dest/config/keys.json" "$keys.new"
cmp -- "$dest/config/keys.json" "$keys.new"
chmod 600 "$keys.new"
mv -- "$keys.new" "$keys"
`
execFileSync('bash', ['-c', restored], { env: process.env, encoding: 'utf8' })
if (!readFileSync(keys).equals(backupBytes)) throw new Error('restore did not return the backup bytes')
if ((statSync(keys).mode & 0o777) !== 0o600) throw new Error('restored keys mode is not 0600')

const afterInstall = readFileSync(keys)
run('search-boost', ['refresh', '-y'])
if (!readFileSync(keys).equals(afterInstall)) throw new Error('refresh changed keys')
if (!readFileSync(keys).equals(backupBytes)) throw new Error('refresh changed keys relative to the backup')

const packedRoot = join(testRoot, 'v030')
mkdirSync(packedRoot, { recursive: true })
const archivePath = join(testRoot, 'v0.3.0.tar')
const tagObject = run('git', ['-C', repo, 'rev-parse', 'v0.3.0']).trim()
const peeled = run('git', ['-C', repo, 'rev-parse', 'v0.3.0^{}']).trim()
if (tagObject !== '12428996dd1aef92f0aedf78ed77066fd59cdbec') throw new Error(`tag object is ${tagObject}`)
if (peeled !== '61c428b786230e71d7a84b2c417da4a9ac246d54') throw new Error(`peeled commit is ${peeled}`)
if (run('git', ['-C', repo, 'cat-file', '-t', tagObject]).trim() !== 'tag') throw new Error('v0.3.0 is not an annotated tag')
run('git', ['-C', repo, 'archive', '--format=tar', '-o', archivePath, peeled])
run('tar', ['-x', '-C', packedRoot, '-f', archivePath])
const v030Name = run('npm', ['pack', '--ignore-scripts'], packedRoot).trim().split('\n').at(-1)
run('npm', ['install', '--global', '--prefix', prefix, join(packedRoot, v030Name)])
const rolled = run('search-boost', ['--version']).trim()
if (rolled !== '0.3.0') throw new Error(`rolled binary printed ${rolled}`)
if (!readFileSync(keys).equals(backupBytes)) throw new Error('installing the v0.3.0 tarball changed keys')
function requestEffect() {
  const root = join(prefix, 'lib', 'node_modules', 'search-boost')
  const code = `
    import { readEngineBaseUrls } from ${JSON.stringify(pathToFileURL(join(root, 'lib', 'keys.mjs')).href)};
    import { engineSearchUrl } from ${JSON.stringify(pathToFileURL(join(root, 'lib', 'engine-endpoints.mjs')).href)};
    const bases = readEngineBaseUrls();
    process.stdout.write(JSON.stringify({
      brave: bases.brave,
      deepseek: bases['deepseek-search'],
      braveRequest: engineSearchUrl('brave', bases),
      deepseekRequest: engineSearchUrl('deepseek-search', bases),
    }));
  `
  return JSON.parse(run('node', ['--input-type=module', '-e', code]))
}
const kept = requestEffect()
if (kept.deepseekRequest !== 'https://api.deepseek.com/messages') throw new Error(`0.3.0 kept request is ${kept.deepseekRequest}`)
if (!kept.braveRequest.startsWith('https://fixture-gateway.example/brave')) throw new Error('0.3.0 did not keep the brave base')
const oldShow = run('search-boost', ['config', 'keys', '--show'])
if (oldShow.includes('/anthropic/v1')) throw new Error('0.3.0 show used the Anthropic default while the beta base was stored')
if (oldShow.includes(secret)) throw new Error('0.3.0 show printed the raw fixture key')
run('search-boost', ['config', 'keys', '--reset-base-url', 'deepseek-search'])
const reset = requestEffect()
if (reset.deepseekRequest !== 'https://api.deepseek.com/anthropic/v1/messages') throw new Error(`0.3.0 reset request is ${reset.deepseekRequest}`)
if (!reset.braveRequest.startsWith('https://fixture-gateway.example/brave')) throw new Error('0.3.0 reset removed the brave base')
const resetShow = run('search-boost', ['config', 'keys', '--show'])
if (!resetShow.includes('https://api.deepseek.com/anthropic/v1')) throw new Error('0.3.0 reset did not show the Anthropic default base')
const resetDoc = JSON.parse(readFileSync(keys, 'utf8'))
if (resetDoc.baseUrls) throw new Error('reset wrote top-level baseUrls')
if (resetDoc.engines?.['deepseek-search']?.baseUrl) throw new Error('reset left engines.deepseek-search.baseUrl')
if (resetDoc.engines?.brave?.baseUrl !== 'https://fixture-gateway.example/brave') throw new Error('reset rewrote engines.brave.baseUrl')
console.log('located keys from config keys --show inside the isolated HOME; backup cmp, failed restore, successful restore, refresh, and 0.3.0 base reset matched the documented steps')
console.log('NOT RUN: a second concurrent keys writer. Existing writes already fail closed and leave the previous file.')
console.log('This isolated HOME is not a user path.')
