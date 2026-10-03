import { t } from './i18n.mjs'

/** Separate consent: a normal refresh is not approval to uninstall or trust. */
export async function confirmGrokCacheRepair(clack, plan) {
  clack.note([
    t(`Plugin: ${plan.name}`, `插件：${plan.name}`),
    t(`Source: ${plan.source} (v${plan.version})`, `源：${plan.source}（v${plan.version}）`),
    t(`Cache: ${plan.path}`, `缓存：${plan.path}`),
    t('Fully quit Grok first. The host will uninstall with --keep-data, then reinstall with --trust. Persistent data is retained in place; legacy-name data reuse is not guaranteed.', '请先完全退出 Grok。宿主将以 --keep-data 卸载，再以 --trust 重装。持久数据原址保留，不保证旧名称的数据自动迁移复用。'),
  ].join('\n'), t('Rebuild Grok plugin cache', '重建 Grok 插件缓存'))
  const choice = await clack.confirm({
    message: t('Approve this cache reconstruction and explicitly trust the displayed source?', '同意重建缓存，并明确信任上述插件源？'),
    initialValue: false,
  })
  // Confirmation can run while sibling refresh transactions are active.
  // Escape is a decline, never process.exit or an empty navigation exception.
  return !clack.isCancel(choice) && choice === true
}
