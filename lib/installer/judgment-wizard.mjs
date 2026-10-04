import { existsSync } from 'node:fs'
import { jevFilePath } from '../jev-config.mjs'
import { capacityFilePath } from '../judgment/capacity.mjs'
import { t } from './i18n.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'
import { decisionRegistry } from '../judgment/registry.mjs'
import { normalizeDecisionBaseUrl } from '../judgment/contract.mjs'
import { activateJudgmentProfile, readJudgmentProfiles, readJudgmentConfig, saveJudgmentProfile, judgmentFilePath } from '../judgment/config.mjs'

/** Local configuration only. Never installs, probes, downloads or uploads. */
export async function runJudgmentWizard(clack, { dryRun = false } = {}) {
  if (!clack) return
  const store = readJudgmentProfiles()
  const choose = async prompt => {
    const value = await clack.select(prompt)
    handleCancel(value, clack)
    return value
  }
  const text = async prompt => {
    const value = await clack.text(prompt)
    handleCancel(value, clack)
    return String(value ?? '').trim()
  }
  const action = await choose({
    message: t('Judgment model profiles', '判断模型配置'),
    options: [
      ...Object.entries(store.profiles).filter(([, profile]) => profile.provider !== 'jev' || profile.apiKey).map(([id, profile]) => ({
        value: id, label: `${id} · ${decisionRegistry.get(profile.provider).label} · ${profile.model}`,
      })),
      { value: '+new', label: t('Add profile', '新增配置') },
      { value: '+cancel', label: t('Cancel', '取消') },
    ],
  })
  if (action === '+cancel') return
  if (action !== '+new') {
    const operation = await choose({ message: t('Profile action', '配置操作'), options: [
      { value: 'activate', label: t('Use this profile', '使用此配置') },
      { value: 'edit', label: t('Edit', '编辑') }, { value: 'cancel', label: t('Cancel', '取消') },
    ] })
    if (operation === 'cancel') return
    if (operation === 'activate') {
      const yes = await clack.confirm({ message: t('Activate this judgment destination?', '启用此判断模型目的地？') })
      handleCancel(yes, clack)
      if (yes && !dryRun) activateJudgmentProfile(action)
      return
    }
  }
  const id = action === '+new' ? await text({
    message: t('Profile name', '配置名称'),
    validate: value => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(value ?? '').trim()) ? t('Use letters, digits, - or _ (1–64)', '使用字母、数字、- 或 _（1–64 字符）') :
      Object.hasOwn(store.profiles, String(value).trim()) ? t('Name already exists', '名称已存在') : undefined,
  }) : action
  const current = action === '+new' ? null : store.profiles[id]
  const provider = await choose({
    message: t('Dedicated judgment provider', '专用判断模型'),
    options: decisionRegistry.list().map(adapter => ({ value: adapter.id, label: adapter.label })),
    initialValue: current?.provider,
  })
  const adapter = decisionRegistry.get(provider)
  const baseUrl = await text({
    message: t('API prefix (endpoint appends /systemone)', 'API 前缀（端点追加 /systemone）'),
    defaultValue: current?.provider === provider ? current.baseUrl : adapter.configSchema.baseUrl.default,
    validate: value => { try { normalizeDecisionBaseUrl(value) } catch { return t('Invalid API prefix URL', 'API 前缀 URL 无效') } },
  })
  const destination = decisionRegistry.configurationFor(provider, baseUrl)
  const model = await choose({ message: t('Model', '模型'), options: destination.models.map(value => ({ value, label: value })), initialValue: destination.models.includes(current?.model) ? current.model : destination.models[0] })
  const authMode = adapter.capabilities.authentication === 'optional-bearer'
    ? await choose({ message: t('Authentication', '认证'), options: [{ value: 'none', label: t('Explicitly no key', '明确无 Key') }, { value: 'bearer', label: 'Bearer API key' }], initialValue: current?.authMode ?? 'none' })
    : 'bearer'
  let apiKey = null
  if (authMode === 'bearer') {
    const keep = current?.provider === provider && current?.baseUrl === normalizeDecisionBaseUrl(baseUrl) ? current.apiKey : null
    const value = await clack.password({ message: keep ? t('API key (empty keeps current)', 'API Key（留空保留原值）') : 'API key',
      validate: value => !String(value ?? '').trim() && !keep ? t('API key required', 'API Key 必填') : undefined })
    handleCancel(value, clack)
    apiKey = String(value ?? '').trim() || keep
  }
  const options = {}
  for (const field of adapter.configSchema.options?.fields ?? []) {
    const value = await text({ message: `${field} ${t('(empty inherits server default)', '（留空使用服务默认值）')}`,
      defaultValue: String(current?.provider === provider ? current.options?.[field] ?? '' : ''),
      validate: value => String(value ?? '').trim() && !/^[1-9]\d*$/.test(String(value).trim()) ? t('Positive integer or empty', '正整数或留空') : undefined })
    options[field] = value ? Number(value) : null
  }
  const config = decisionRegistry.validateConfig({ provider, baseUrl, model, authMode, apiKey, ...(adapter.configSchema.options ? { options } : {}) })
  clack.log.info(`${adapter.label} · ${model} · ${destination.endpoint} · ${authMode}`)
  clack.log.info(t('Question, intent and material fragments go to this destination; engine keys do not.', '问题、方向与材料片段将发送至此目的地；引擎 Keys 不会发送。'))
  if (provider === 'laya') clack.log.info(t('Laya requires full diagnostics and pinned offline question-head capacity evidence; missing evidence makes judgments unavailable. No model quality claim.', 'Laya 需要完整诊断与固定版本的离线题头容量证据；缺少证据时判断不可用。不保证模型判断质量。'))
  const confirmed = await clack.confirm({ message: t('Save and use this profile?', '保存并使用此配置？') })
  handleCancel(confirmed, clack)
  if (!confirmed) return
  if (dryRun) clack.log.info(t('dry-run: profile not written', 'dry-run：未写入配置'))
  else {
    saveJudgmentProfile(id, config)
    clack.log.success(t('Judgment profile saved', '判断模型配置已保存'))
  }
}

/** Status describes the selected profile, never an unrelated legacy key. */
export function formatJudgmentStatusLines() {
  try {
    const config = readJudgmentConfig()
    if (!config.ready) return []
    const destination = decisionRegistry.configurationFor(config.provider, config.baseUrl)
    return [t('Judgment model', '判断模型'), RULE,
      `  profile    ${config.profileId}`,
      `  provider   ${config.provider} · ${config.model} · ${config.transport}`,
      `  endpoint   ${destination.endpoint}`,
      `  auth       ${config.authMode} (${config.source}; configuration only, not connectivity)`,
      ...(config.provider === 'laya' ? [`  capacity   ${config.capacityStatus}; offline evidence required (${tildify(capacityFilePath(config.profileId))})`] : []),
      `  file       ${tildify(config.profileId === 'legacy-jev' && !existsSync(judgmentFilePath()) ? jevFilePath() : judgmentFilePath())}`,
    ]
  } catch {
    return [t('Judgment model', '判断模型'), RULE, t('  Configuration unreadable; repair the selected profile. No legacy fallback.', '  配置不可读；请修复当前配置。不会回退旧凭据。'), `  file       ${tildify(judgmentFilePath())}`]
  }
}
