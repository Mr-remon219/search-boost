/**
 * @typedef {Object} InstallOpts
 * @property {boolean} [dryRun]
 * @property {boolean} [autoAllow]
 * @property {boolean} [replaceNative]  Disable built-in web_search where the agent allows it
 * @property {boolean} [mergeCursorCli]
 * @property {'user'|'project'|'all'} [scope]
 * @property {string|null} [workspace]
 * @property {boolean} [skipGrokPlugin]
 * @property {string|null} [profile]  DSH only: profile under $DSH_HOME/profiles (default web)
 * @property {'desktop'|'cli'|'all'|null} [dshSurface]  DSH install/uninstall surface
 * @property {boolean} [enableDshBundle]  Explicit opt-in to enable a retained DSH bundle
 * @property {Function} [onDshStatus]  Installed source and enabled/disabled status
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} label
 * @property {(opts: InstallOpts) => Promise<string[]>} install
 * @property {(opts: InstallOpts) => Promise<void>} uninstall
 * @property {(opts?: { autoAllow?: boolean, replaceNative?: boolean, scope?: 'user'|'project'|'all' }) => string} printConfig
 */

export {}
