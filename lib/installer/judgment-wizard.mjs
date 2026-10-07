import { existsSync } from 'node:fs'
import { jevFilePath, JEV_DEFAULT_BASE_URL, normalizeJevBaseUrl } from '../jev-config.mjs'
import { capacityFilePath } from '../judgment/capacity.mjs'
import { t, tuiContext, TuiHome } from './i18n.mjs'
import { handleCancel, RULE, tildify } from './ui.mjs'
import { decisionRegistry } from '../judgment/registry.mjs'
import { normalizeDecisionBaseUrl } from '../judgment/contract.mjs'
import { activateJudgmentProfile, readJudgmentProfiles, readJudgmentConfig, saveJudgmentProfile, removeJudgmentProfile, judgmentFilePath } from '../judgment/config.mjs'

/** Local configuration only. Never installs, probes, downloads or uploads. */
export async function runJudgmentWizard(clack, { dryRun = false, onboarding = false } = {}) {
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
  const available = Object.entries(store.profiles).filter(([, profile]) => profile.provider !== 'jev' || profile.apiKey)
  const home = { value: 'home', label: t('Back to main menu', '返回主菜单') }
  const back = { value: 'back', label: t('Back to previous page', '返回上一页') }
  const navigation = onboarding ? [back] : [back, home]
  while (true) {
    const action = await choose({
      message: t('Judgment model configuration', '判断模型配置'),
      options: [
        ...(available.length ? [{ value: 'existing', label: t('Existing configuration', '现有配置'), hint: t('use or manage saved configurations', '使用或管理已保存配置') }] : []),
        { value: 'change', label: t('Change configuration', '更改配置'), hint: 'Jev / Laya' },
        onboarding ? back : home,
      ],
    })
    if (action === 'back') return 'back'
    if (action === 'home') {
      if (tuiContext()?.navigation) throw new TuiHome()
      return
    }
    const result = action === 'existing' ? await existing() : await configure()
    if (result === 'back') continue
    if (result === 'home' && tuiContext()?.navigation) throw new TuiHome()
    return
  }

  async function existing() {
    while (true) {
      const selected = await choose({
        message: t('Existing configurations', '现有配置'),
        options: [
          ...available.map(([id, profile]) => ({
            // ':' is not allowed in stored IDs, so encoded profiles cannot
            // collide with navigation commands, including legacy home/back IDs.
            value: `profile:${id}`, label: `${id} · ${decisionRegistry.get(profile.provider).label} · ${profile.model}`,
            hint: id === store.activeProfile ? t('current', '当前使用') : undefined,
          })),
          ...navigation,
        ],
        initialValue: available.some(([id]) => id === store.activeProfile) ? `profile:${store.activeProfile}` : undefined,
      })
      if (selected === 'back' || selected === 'home') return selected
      const id = available.find(([id]) => selected === `profile:${id}`)?.[0]
      if (!id) throw new Error('Unknown judgment profile selection')
      const operation = await choose({ message: t('Profile action', '配置操作'), options: [
        { value: 'activate', label: t('Use this profile', '使用此配置') },
        { value: 'remove', label: t('Delete profile and its stored key', '删除配置及其存储的 Key') },
        ...navigation,
      ] })
      if (operation === 'back') continue
      if (operation === 'home') return 'home'
      if (operation === 'remove') {
        clack.log.info(t('This removes only this profile. Other profiles and legacy keys are unchanged; deleting the active profile disables judgments without selecting another destination.', '仅移除此配置；其他配置及旧凭据不变。删除当前配置会停用判断，不会自动选择其他目的地。'))
        const yes = await clack.confirm({ message: t('Delete this profile and its stored key?', '删除此配置及其存储的 Key？') })
        handleCancel(yes, clack)
        if (yes && !dryRun) removeJudgmentProfile(id)
        return
      }
      if (operation === 'activate') {
        const yes = await clack.confirm({ message: t('Activate this judgment destination?', '启用此判断模型目的地？') })
        handleCancel(yes, clack)
        if (yes && !dryRun) activateJudgmentProfile(id)
        return
      }
    }
  }

  async function configure() {
    const active = available.find(([id]) => id === store.activeProfile)?.[1]
    let provider, baseUrl
    while (true) {
      provider = await choose({
        message: t('Dedicated judgment provider', '专用判断模型'),
        // Only the two reviewed typed-decision integrations, never chat providers.
        options: [...['jev', 'laya'].map(id => ({ value: id, label: id === 'laya' ? t('Laya (self-hosted)', 'Laya（自部署）') : decisionRegistry.get(id).label })), ...navigation],
        initialValue: active?.provider,
      })
      if (provider === 'back' || provider === 'home') return provider
      baseUrl = undefined
      if (provider === 'jev') {
        const route = await choose({ message: t('Jev Base URL', 'Jev Base URL'), options: [
          { value: 'typesafe', label: 'TypeSafe', hint: JEV_DEFAULT_BASE_URL },
          { value: 'vercel', label: 'Vercel AI Gateway', hint: t('dedicated evaluation API · Gateway key', '专用评估接口 · Gateway Key') },
          { value: 'custom', label: t('Custom System One Base URL', '自定义 System One Base URL'), hint: t('same supported protocol, not a chat API', '须使用已支持的协议，非聊天接口') },
          ...navigation,
        ] })
        if (route === 'back') continue
        if (route === 'home') return 'home'
        if (route === 'typesafe') baseUrl = JEV_DEFAULT_BASE_URL
        else if (route === 'vercel') baseUrl = 'https://ai-gateway.vercel.sh/v1'
      }
      break
    }
    return saveConfiguration(provider, baseUrl, active)
  }

  async function saveConfiguration(provider, baseUrl, active) {
    const adapter = decisionRegistry.get(provider)
    if (!baseUrl) baseUrl = await text({
      message: t('Base URL (API prefix, without /systemone)', 'Base URL（API 前缀，不含 /systemone）'),
      defaultValue: active?.provider === provider ? active.baseUrl : adapter.configSchema.baseUrl.default,
      validate: value => { try { decisionRegistry.configurationFor(provider, value) } catch { return t('Invalid Base URL for this provider', '此提供方的 Base URL 无效') } },
    })
    baseUrl = provider === 'jev' ? normalizeJevBaseUrl(baseUrl) : normalizeDecisionBaseUrl(baseUrl)
    const destination = decisionRegistry.configurationFor(provider, baseUrl)
    const matching = available.find(([id, profile]) => id === store.activeProfile && profile.provider === provider && profile.baseUrl === baseUrl)
      ?? available.find(([, profile]) => profile.provider === provider && profile.baseUrl === baseUrl)
    const current = matching?.[1]
    // Keep model/budgets of an existing destination; new Laya uses multilingual.
    const model = current?.model ?? (provider === 'laya' ? 'multilingual' : destination.models[0])
    const vercel = destination.transport === 'vercel-evaluation'
    if (vercel) clack.log.info(t('Vercel uses the dedicated typesafe-ai/jev evaluation API. Enter a Vercel AI Gateway key, not a TypeSafe key.', 'Vercel 使用 typesafe-ai/jev 专用评估接口。请填写 Vercel AI Gateway Key，而非 TypeSafe Key。'))
    const keep = current?.apiKey ?? null
    const value = await clack.password({
      message: keep ? provider === 'laya' ? t('API key (empty keeps current; - clears key)', 'API Key（留空保留；输入 - 清除 Key）') : t('API key (empty keeps current)', 'API Key（留空保留原值）')
        : provider === 'laya' ? t('API key (optional; empty for no authentication)', 'API Key（可选，无认证请留空）')
          : vercel ? 'Vercel AI Gateway API key' : 'TypeSafe / System One API key',
      validate: value => provider === 'jev' && !String(value ?? '').trim() && !keep ? t('API key required', 'API Key 必填') : undefined,
    })
    handleCancel(value, clack)
    const entered = String(value ?? '').trim()
    const apiKey = provider === 'laya' && entered === '-' ? null : entered || keep
    const authMode = apiKey ? 'bearer' : 'none'
    const options = current?.options ?? { max_len: null, head_max_len: null }
    let id = matching?.[0]
    if (!id) {
      const name = vercel ? 'jev-vercel' : provider
      id = name
      for (let suffix = 2; Object.hasOwn(store.profiles, id); suffix++) id = `${name}-${suffix}`
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
}

/** Status describes the selected profile, never an unrelated legacy key. */
export function formatJudgmentStatusLines() {
  try {
    const config = readJudgmentConfig()
    if (!config.ready) return config.source === 'file' ? [t('Judgment model', '判断模型'), RULE,
      t('  No active profile; judgments disabled. Legacy credentials are not used.', '  无当前配置；判断已停用，不使用旧凭据。'), `  file       ${tildify(judgmentFilePath())}`] : []
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
