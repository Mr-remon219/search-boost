/**
 * @typedef {Object} InstallOpts
 * @property {boolean} [dryRun]
 * @property {boolean} [autoAllow]
 * @property {boolean} [mergeCursorCli]
 * @property {'user'|'project'} [scope]
 * @property {string|null} [workspace]
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} label
 * @property {(opts: InstallOpts) => Promise<string[]>} install
 * @property {(opts: InstallOpts) => Promise<void>} uninstall
 * @property {() => string} printConfig
 */

export {}
