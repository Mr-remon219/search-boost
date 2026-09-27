import { toolStates, saveToolPreferences, toolsFilePath } from '../tool-config.mjs'

/** Clack 0.10 has no disabled multiselect rows. Render locked rows in the
 * adjacent status panel and omit them from selectable choices entirely. */
export async function runToolsWizard(clack, { dryRun = false } = {}) {
  try {
    const states = toolStates()
    clack.note(states.map((row) => row.locked
      ? `\u001b[9m${row.name}\u001b[29m  [locked] ${row.reason}`
      : `${row.enabled ? '[on] ' : '[off]'} ${row.name}`).join('\n'), 'Tool switches — shared by MCP / Pi / DSH')
    const choices = states.filter((row) => !row.locked)
    const selected = await clack.multiselect({
      message: 'Enabled tools (Space: toggle · Enter: review · Esc: cancel)',
      options: choices.map(({ name, hint }) => ({ value: name, label: name, hint })),
      initialValues: choices.filter((row) => row.enabled).map((row) => row.name),
      required: false,
    })
    if (clack.isCancel(selected)) return
    const patch = Object.fromEntries(choices.filter((row) => selected.includes(row.name) !== row.requested)
      .map((row) => [row.name, selected.includes(row.name)]))
    if (!Object.keys(patch).length) { clack.log.info('No changes.'); return }
    clack.note(Object.entries(patch).map(([name, enabled]) => `${enabled ? 'ON ' : 'OFF'} ${name}`).join('\n'), 'Pending changes')
    const confirmed = await clack.confirm({ message: 'Save shared tool switches?', initialValue: true })
    if (clack.isCancel(confirmed) || !confirmed) return
    if (dryRun) { clack.log.info(`dry-run: would update ${toolsFilePath()} (nothing written)`); return }
    saveToolPreferences(patch)
    clack.log.success(`Saved → ${toolsFilePath()}`)
    clack.log.info('New calls are gated immediately; running calls finish normally. MCP / Pi tool lists refresh within ~300ms. DSH keeps registered tools but rejects disabled calls. Hosts caching MCP lists may need reconnecting. Already-running older adapters need one reload.')
  } catch (error) { clack.log.error(error.message) }
}
