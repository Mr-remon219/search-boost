/**
 * @typedef {Object} InstallOpts
 * @property {boolean} [dryRun]
 * @property {boolean} [autoAllow]
 * @property {boolean} [replaceNative]  Disable built-in web_search where the agent allows it
 * @property {boolean} [mergeCursorCli]
 * @property {'user'|'project'|'all'} [scope]
 * @property {string|null} [workspace]
 * @property {boolean} [skipGrokPlugin]
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
