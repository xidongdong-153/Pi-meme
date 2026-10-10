import { createHash } from 'node:crypto'

const script = `
const notice = document.querySelector('[role="alert"]')
const buttons = [...document.querySelectorAll('button')]
window.piPlatform.getHostConnectionError().then(error => {
  if (!error) return
  document.querySelector('h1').textContent = error.local ? '本地 Host 启动失败' : '无法连接远程 Host'
  notice.textContent = error.message
  document.getElementById('retry').textContent = error.local ? '重新启动' : '重试连接'
  document.getElementById('local').hidden = error.local
}).catch(cause => { notice.textContent = String(cause.message || cause) })
async function run(action) {
  buttons.forEach(button => { button.disabled = true })
  notice.textContent = '正在连接 Host'
  try { await action() }
  catch (cause) { notice.textContent = '连接失败：' + String(cause.message || cause) }
  finally { buttons.forEach(button => { button.disabled = false }) }
}
document.getElementById('retry').onclick = () => run(() => window.piPlatform.retryHostConnection())
document.getElementById('local').onclick = () => run(() => window.piPlatform.setHostConnection(null))
`
const hash = createHash('sha256').update(script).digest('base64')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Host 连接失败</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#191919;color:#ddd;font:14px system-ui}main{max-width:480px;padding:32px}button{margin:12px 12px 0 0;padding:8px 16px;background:#333;color:#eee;border:1px solid #555;border-radius:6px}button:disabled{opacity:.5}p{line-height:1.7}</style></head><body><main><h1>无法连接 pi-meme Host</h1><p role="alert">检查 Host 地址和网络，然后重试；也可以连接本地 Host。</p><button id="retry" type="button">重试连接</button><button id="local" type="button">连接本地 Host</button></main><script>${script}</script></body></html>`

// 必须匹配完整地址，不能把其他 data: 或 file: 页面当作可信恢复页。
export const recoveryUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
