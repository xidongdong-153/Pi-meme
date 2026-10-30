import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 32, fontFamily: 'system-ui', color: '#ddd', background: '#191919', minHeight: '100vh' }}>
    <h1>无法打开 Pi meme</h1>
    <p>请重启应用后再试。</p>
    <button type="button" onClick={() => window.location.reload()}>
      重新连接
    </button>
  </main>,
)
