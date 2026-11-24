import { createInterface } from 'node:readline/promises'
import { initializeNativeSession } from '../community/native-session.mjs'

export async function runCommunityLogin(platform) {
  if (!process.stdin.isTTY) throw new Error('community-login requires an interactive terminal; login is performed by the user')
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  try {
    console.log('将打开 SearchBoost 专用浏览器；请本人登录并完成平台验证。不会导入个人浏览器 Cookie。')
    const ready = await initializeNativeSession(platform, async () => (await terminal.question('完成登录后输入 yes 保存会话；其他输入取消：', { signal: controller.signal })).trim() === 'yes', { signal: controller.signal })
    console.log(ready ? '会话已保存。请在 Community 配置选择“站内正文”，再执行实际检索验收；登录确认不是连通性证明。' : '未确认会话；未启用任何检索来源。')
  } finally { process.removeListener('SIGINT', abort); terminal.close() }
}
