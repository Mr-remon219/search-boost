#!/usr/bin/env node
/**
 * search-boost CLI — one command surface, one TUI.
 */
import { help, installOpts, parseFlags } from './lib/cli/args.mjs'
import {
  printAgentsTsv,
  printSnippet,
  runConfigKeys,
  runConfigLayer,
  runConfigSearchCmd,
  runConfigX,
  runDoctor,
  runInstall,
  runPlugin,
} from './lib/cli/commands.mjs'
import { runWizard } from './lib/installer/index.mjs'
import { printStatus } from './lib/installer/status.mjs'
import { runTui } from './lib/installer/tui.mjs'
import { getVersion } from './lib/pkg.mjs'

const argv = process.argv.slice(2)

async function main() {
  if (argv.length === 0) {
    await runTui()
    return
  }

  const cmd = argv[0]

  switch (cmd) {
    case 'serve':
    case 'mcp':
      await import('./server.mjs')
      break
    case 'setup':
    case 'wizard':
      await runWizard(installOpts(parseFlags(argv.slice(1))))
      break
    case 'install':
      await runInstall(false, argv.slice(1))
      break
    case 'uninstall':
      await runInstall(true, argv.slice(1))
      break
    case 'print': {
      const flags = parseFlags(argv.slice(1))
      const id = argv[1] && !argv[1].startsWith('-') ? argv[1] : flags.printConfig
      if (!id) throw new Error('Usage: search-boost print <agent> [--auto-allow] [--keep-native]')
      printSnippet(id, flags)
      break
    }
    case 'config': {
      const sub = argv[1]
      if (sub === 'keys') await runConfigKeys(argv.slice(2))
      else if (sub === 'layer') await runConfigLayer(argv.slice(2))
      else if (sub === 'x') await runConfigX(argv.slice(2))
      else if (sub === 'search') await runConfigSearchCmd(argv.slice(2))
      else if (sub === 'diag') {
        const result = await runDoctor(argv.slice(2), { deprecated: true })
        process.exitCode = result.exitCode
      } else throw new Error('Usage: search-boost config keys|layer|x|search|diag')
      break
    }
    case 'doctor': {
      const result = await runDoctor(argv.slice(1))
      process.exitCode = result.exitCode
      break
    }
    case 'agents':
      printAgentsTsv()
      break
    case 'status':
      printStatus()
      break
    case 'plugin':
      await runPlugin(argv[1])
      break
    case '-v':
    case '--version':
    case 'version':
      console.log(getVersion())
      break
    case '-h':
    case '--help':
    case 'help':
      help()
      break
    default:
      throw new Error(`Unknown command: ${cmd}`)
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg)
  if (msg.startsWith('Unknown command:')) help()
  process.exit(1)
})
