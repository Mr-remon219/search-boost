import { t, TuiCancelled, toolHint, toolUnavailableReason } from './i18n.mjs'
import { toolStates, saveToolPreferences, toolsFilePath } from '../tool-config.mjs'

/** Clack 0.10 has no disabled multiselect rows. Render locked rows in the
 * adjacent status panel and omit them from selectable choices entirely. */
export async function runToolsWizard(clack, { dryRun = false } = {}) {
  try {
    clack.note(t('These switches control direct tool entries, not all network use. OFF fetch_page still allows enabled adaptive to read internally; OFF x_search still allows fused community retrieval. Searchers require fused_search AND fetch_page; disabling either blocks new research dispatch. Engine switches control which engines are called; zero weights only affect ranking.', '这些开关控制直接工具入口，不是所有网络能力。停用 fetch_page 后，启用的 adaptive 仍可内部读取；停用 x_search 后，fused 的 community 仍可检索 X。Searcher 必须同时启用 fused_search 与 fetch_page，否则派发前拒绝。引擎开关控制是否调用引擎，零权重只改变排序。'), t('Scope and dependencies', '影响范围与依赖'))
    const states = toolStates()
    clack.note(states.map((row) => row.locked
      ? `\u001b[9m${row.name}\u001b[29m  ${t('[locked]', '[不可用]')} ${toolUnavailableReason(row.reason)}`
      : `${row.enabled ? t('[on] ', '[启用] ') : t('[off]', '[停用]')} ${row.name}`).join('\n'), t('Tool switches — shared by MCP / Pi / DSH', "工具开关 — MCP / Pi / DSH 共享"))
    const choices = states.filter((row) => !row.locked)
    const selected = await clack.multiselect({
      message: t('Enabled tools (Space: toggle · Enter: review · Esc: cancel)', "启用的工具（空格：切换 · Enter：预览 · Esc：取消）"),
      options: choices.map(({ name, hint }) => ({ value: name, label: name, hint: toolHint(name, hint) })),
      initialValues: choices.filter((row) => row.enabled).map((row) => row.name),
      required: false,
    })
    if (clack.isCancel(selected)) return
    const patch = Object.fromEntries(choices.filter((row) => selected.includes(row.name) !== row.requested)
      .map((row) => [row.name, selected.includes(row.name)]))
    if (!Object.keys(patch).length) { clack.log.info(t('No changes.', "没有变更。")); return }
    clack.note(Object.entries(patch).map(([name, enabled]) => `${enabled ? t('ON ', '启用') : t('OFF', '停用')} ${name}`).join('\n'), t('Pending changes', "待保存的变更"))
    const confirmed = await clack.confirm({ message: t('Save shared tool switches?', "保存共享工具开关？"), initialValue: true })
    if (clack.isCancel(confirmed) || !confirmed) return
    if (dryRun) { clack.log.info(t(`dry-run: would update ${toolsFilePath()} (nothing written)`, `dry-run：将更新 ${toolsFilePath()}（不写入配置）。`)); return }
    saveToolPreferences(patch)
    clack.log.success(t(`Saved → ${toolsFilePath()}`, `已保存 → ${toolsFilePath()}`))
    clack.log.info(t('New calls are gated immediately; running calls finish normally. MCP / Pi tool lists refresh within ~300ms. DSH keeps registered tools but rejects disabled calls. Hosts caching MCP lists may need reconnecting. Already-running older adapters need one reload.', "新调用立即受开关限制，正在执行的调用正常完成。MCP / Pi 工具列表约 300ms 内刷新。DSH 保留已注册工具，但拒绝已停用工具的调用。缓存 MCP 列表的宿主可能需要重新连接；运行中的旧版适配器需要重新加载一次。"))
  } catch (error) {
    if (error instanceof TuiCancelled) throw error
    clack.log.error(t('Operation failed:', '操作失败：'))
    clack.log.error(error.message)
  }
}
