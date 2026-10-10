import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 32, fontFamily: 'system-ui', color: '#ddd', background: '#191919', minHeight: '100vh' }}>
    <h1>无法打开 pi-meme Host</h1>
    <p>检查 Host 是否正在运行，然后重新打开窗口。</p>
    <button type="button" onClick={() => window.location.reload()}>
      重新连接
    </button>
  </main>,
)
