const LABELS = {
  unconfigured: ['未连接', 'Not connected'], configured: ['已配置', 'Configured'], paused: ['已暂停', 'Paused'],
  login: ['需登录', 'Login needed'], browser: ['浏览器待修复', 'Browser needs repair'],
}
export function platformConnection(backends, platform, setup) {
  const native = backends.find(row => row.provider === `${platform}-native` && row.enabled)
  const saved = backends.some(row => row.provider === `${platform}-native`)
  const status = native ? !setup.session ? 'login' : !setup.browser.ready ? 'browser' : 'configured'
    : setup.session ? !setup.browser.ready ? 'browser' : 'paused' : saved ? 'login' : 'unconfigured'
  return { status, enabled: Boolean(native), configured: status === 'configured', label: LABELS[status] }
}
export function reusableBrowserChoice(state) {
  if (!state.browser?.ready || state.preference?.source === 'invalid') return null
  return state.browser.source === 'managed' ? { source: 'managed' }
    : (state.browser.path ?? state.preference?.path ?? state.localBrowsers?.[0]?.path) ? { source: 'system', path: state.browser.path ?? state.preference?.path ?? state.localBrowsers[0].path } : null
}
export function browserChoices(state) {
  return [
    ...(state.localBrowsers ?? []).map(browser => ({ value: `local:${browser.id}`, choice: { source: 'system', path: browser.path }, label: browser.label })),
    { value: 'managed', choice: { source: 'managed' }, label: state.managedBrowser?.ready ? 'installed' : 'download' },
  ]
}
export function communityErrorText(error) {
  const kind = error?.kind ?? (error?.name === 'TimeoutError' ? 'timeout' : 'unknown')
  const text = {
    qr_login_timeout: ['等待扫码超时，重发二维码即可。', 'Scan timed out. Request a new QR.'],
    qr_unavailable: ['暂时无法取得二维码，请重试。', 'QR unavailable. Please retry.'],
    qr_login_failed: ['平台暂未完成登录，请重试。', 'Platform login incomplete. Please retry.'],
    session_busy: ['此平台正在使用，稍后重试；无需重新配置。', 'This platform is busy. Retry shortly; no setup needed.'],
    browser_busy: ['浏览器正在使用，结束检索后再试。', 'Browser in use. Retry after retrieval ends.'],
    session_required: ['请在社区检索中扫码连接此平台。', 'Connect this platform in Community.'],
    session_expired: ['登录已失效，在社区检索中重新扫码即可。', 'Login expired. Scan again in Community.'],
    browser_unavailable: ['浏览器不可用，请在浏览器设置中重新选择或安装。', 'Browser unavailable. Choose or install one in browser settings.'],
    browser_install_failed: ['下载未完成，重试即可；已有登录数据保留。', 'Download incomplete. Retry; saved logins are kept.'],
    browser_preference_invalid: ['浏览器设置损坏，请修复 browser-preference.json。', 'Repair the damaged browser-preference.json.'],
    managed_browser_unsafe: ['下载目录归属不明，已停止操作以保护本机数据。', 'Download ownership unclear. Stopped to protect local data.'],
    native_setup_unsafe: ['会话目录不安全，已停止操作以保护本机数据。', 'Session directory unsafe. Stopped to protect local data.'],
    rate_limited: ['平台限流，请稍后重试；无需重新配置。', 'Platform rate limit. Retry later; no setup needed.'],
    access_denied: ['平台暂时限制访问，请稍后重试。', 'Platform access restricted. Retry later.'],
    redirect_blocked: ['平台跳转受网络策略限制，未绕过限制。', 'Platform redirect blocked by network policy.'],
    timeout: ['请求超时，请稍后重试；已有配置保留。', 'Request timed out. Retry later; settings are kept.'],
  }[kind]
  if (text) return text
  if (String(error?.message).startsWith('Community configuration changed')) return ['此平台配置已更改，未覆盖；已保存的登录仍保留。', 'This platform changed elsewhere. Saved login kept; settings not overwritten.']
  return ['连接未完成，请重试；已有配置保留。', 'Connection incomplete. Retry; saved settings are kept.']
}
export function communityRecoveryNote(reason, platform) {
  const action = {
    session_required: `Connect ${platform} in Community once, then search directly.`,
    session_expired: `Scan again for ${platform} in Community; reinstall is not needed.`,
    browser_busy: 'Browser in use. Retry shortly; saved login is unchanged.',
    session_busy: 'Platform session busy. Retry shortly; do not reset configuration.',
    browser_unavailable: 'Choose or install a browser in Community > Browser settings; saved login is kept.',
    browser_preference_invalid: 'Repair browser-preference.json; saved login is kept.',
    rate_limited: 'Retry later; do not reconfigure or log in again.',
    access_denied: 'Platform access restricted. Retry later; do not assume login expired.',
    redirect_blocked: 'Redirect blocked by network policy; no bypass was attempted.',
    timeout: 'Request timed out. Retry later; saved settings are unchanged.',
  }
  return action[reason] ?? 'Retrieval incomplete. Retry later; saved settings are unchanged.'
}
