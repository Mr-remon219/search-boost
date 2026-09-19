/** Explicit transition-release entry; reuse the verified upgrade/handoff pipeline. */
import { getPackageName } from '../pkg.mjs'
import { runUpgradeCli } from './cli.mjs'

export async function runMigrationCli(args, { run, log } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`search-boost-mcp migrate [-y] [--dry-run] [--workspace PATH]
Install search-boost@latest, verify it, then migrate existing integrations using the new package.
Run without -y for confirmation. --dry-run changes no packages, integrations, or credentials.
Requires the command-renaming transition release and a published search-boost package.
Old global packages and credential files are retained; restart affected hosts afterward.
Standalone equivalent: node /path/to/search-boost-mcp/migrate.mjs [options]`)
    return
  }
  if (getPackageName() !== 'search-boost-mcp') {
    throw new Error('This migration entry is for the search-boost-mcp transition release. You are already using search-boost; use search-boost upgrade instead.')
  }
  if (args.includes('--sync-only')) throw new Error('Migration must install/verify the new package first; --sync-only is not supported. Use --dry-run to preview.')
  return runUpgradeCli(args, {
    command: 'search-boost-mcp migrate',
    confirmMessage: 'Migrate search-boost-mcp to search-boost@latest and update existing integrations? Credentials, permissions and the old global package are retained.',
    run,
    log,
  })
}
