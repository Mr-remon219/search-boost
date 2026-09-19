#!/usr/bin/env node
/** Standalone script shipped in the transition release; never runs at npm install time. */
import { runMigrationCli } from './lib/upgrade/migrate.mjs'

runMigrationCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : 'Migration failed')
  process.exitCode = 1
})
