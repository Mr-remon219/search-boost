#!/usr/bin/env node
/** Explicit npm-name migration entry shipped in search-boost; never runs at install time. */
import { runMigrationCli } from './lib/upgrade/migrate.mjs'

runMigrationCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : 'Migration failed')
  process.exitCode = 1
})
