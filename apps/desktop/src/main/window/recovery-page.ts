import { createHash } from 'node:crypto'

const script = `
const notice = document.querySelector('[role="alert"]')
const buttons = [...document.querySelectorAll('button')]
window.piPlatform.getHostConnectionError().then(error => {
  if (!error) return
  document.querySelector('h1').textContent = error.local ? '应用启动失败' : '无法连接远程设备'
  notice.textContent = error.message
  document.getElementById('retry').textContent = error.local ? '重新启动' : '重试连接'
  document.getElementById('local').hidden = error.local
}).catch(cause => { notice.textContent = String(cause.message || cause) })
async function run(action) {
  buttons.forEach(button => { button.disabled = true })
  notice.textContent = '正在连接…'
  try { await action() }
  catch (cause) { notice.textContent = '连接失败：' + String(cause.message || cause) }
  finally { buttons.forEach(button => { button.disabled = false }) }
}
document.getElementById('retry').onclick = () => run(() => window.piPlatform.retryHostConnection())
document.getElementById('local').onclick = () => run(() => window.piPlatform.setHostConnection(null))
`
const hash = createHash('sha256').update(script).digest('base64')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>连接失败</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#191919;color:#ddd;font:14px system-ui}body::before{content:'';position:fixed;inset:0 138px auto 0;height:36px;-webkit-app-region:drag}main{max-width:480px;padding:32px}button{margin:12px 12px 0 0;padding:8px 16px;background:#333;color:#eee;border:1px solid #555;border-radius:6px}button:disabled{opacity:.5}p{line-height:1.7}</style></head><body><main><h1>无法连接 Pi meme</h1><p role="alert">请检查连接地址和网络后重试，或切换到此计算机。</p><button id="retry" type="button">重试连接</button><button id="local" type="button">连接此计算机</button></main><script>${script}</script></body></html>`

// 必须匹配完整地址，不能把其他 data: 或 file: 页面当作可信恢复页。
export const recoveryUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
