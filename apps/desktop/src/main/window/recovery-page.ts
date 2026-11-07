import { createHash } from 'node:crypto'

const script = `
const notice = document.querySelector('[role="alert"]')
const buttons = [...document.querySelectorAll('button')]
let pairingUrl
window.piPlatform.getHostConnectionError().then(error => {
  if (!error) return
  document.querySelector('h1').textContent = error.local ? '应用启动失败' : '无法连接远程设备'
  notice.textContent = error.message
  document.getElementById('retry').textContent = error.local ? '重新启动' : '重试连接'
  document.getElementById('local').hidden = error.local
  if (error.pairingUrl) {
    pairingUrl = error.pairingUrl
    document.querySelector('h1').textContent = '连接已有本机服务'
    document.getElementById('address').textContent = pairingUrl
    document.getElementById('pairing').hidden = false
    document.getElementById('token').focus()
  }
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
document.getElementById('pairing').onsubmit = event => {
  event.preventDefault()
  if (!pairingUrl) return
  const token = document.getElementById('token')
  if (!token.reportValidity()) return
  run(async () => {
    await window.piPlatform.setHostConnection({ url: pairingUrl, token: token.value, save: document.getElementById('remember').checked })
    token.value = ''
  })
}
`
const hash = createHash('sha256').update(script).digest('base64')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>连接失败</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#191919;color:#ddd;font:14px system-ui}body::before{content:'';position:fixed;inset:0 138px auto 0;height:36px;-webkit-app-region:drag}main{max-width:480px;padding:32px}button{margin:12px 12px 0 0;padding:8px 16px;background:#333;color:#eee;border:1px solid #555;border-radius:6px}button:disabled{opacity:.5}p{line-height:1.7;overflow-wrap:anywhere}form{margin-block:24px}form[hidden]{display:none}label{display:block;margin-block:12px 8px}input[type=password]{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #777;border-radius:6px;background:#222;color:#eee;font:inherit}input[type=checkbox]{accent-color:#ddd}button:hover{background:#444}button:focus-visible,input:focus-visible{outline:2px solid #ddd;outline-offset:3px}</style></head><body><main><h1>无法连接 Pi meme</h1><p role="alert">请检查连接地址和网络后重试，或切换到此计算机。</p><form id="pairing" hidden><p id="address"></p><label for="token">访问令牌</label><input id="token" type="password" autocomplete="off" spellcheck="false" maxlength="4096" required><label><input id="remember" type="checkbox" checked> 保存配对（系统加密）</label><button type="submit">配对并连接</button></form><button id="retry" type="button">重试连接</button><button id="local" type="button">连接此计算机</button></main><script>${script}</script></body></html>`

// 必须匹配完整地址，不能把其他 data: 或 file: 页面当作可信恢复页。
export const recoveryUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
