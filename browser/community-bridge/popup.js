const endpoint = document.getElementById('endpoint'), token = document.getElementById('token'), status = document.getElementById('status')
const cfg = await chrome.storage.local.get(['endpoint', 'token', 'enabled'])
endpoint.value = cfg.endpoint ?? endpoint.value; token.value = cfg.token ?? ''; status.textContent = cfg.enabled ? 'Enabled' : 'Disabled'
document.getElementById('start').onclick = async () => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.value) || token.value.length < 32) { status.textContent = 'Use a loopback endpoint and the bridge token file'; return }
  await chrome.storage.local.set({ endpoint: endpoint.value, token: token.value, enabled: true })
  await chrome.runtime.sendMessage({ action: 'start' }); status.textContent = 'Enabled'
}
document.getElementById('stop').onclick = async () => { await chrome.storage.local.set({ enabled: false }); status.textContent = 'Disabled' }
