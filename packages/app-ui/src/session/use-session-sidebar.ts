import { useCallback, useEffect, useState } from 'react'

export function useSessionSidebar(host: string, session: string) {
  const key = `pi-meme:sidebar:v1:${JSON.stringify([host, session])}`
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (typeof value?.open === 'boolean' && Number.isFinite(value.width))
        return { key, open: value.open as boolean, width: Math.max(160, Math.min(600, value.width)) }
    } catch {
      /* 存储不可用时使用默认布局。 */
    }
    return { key, open: true, width: 256 }
  }
  const [state, setState] = useState(read)
  if (state.key !== key) setState(read())
  useEffect(() => {
    if (state.key !== key) return
    try {
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* 内存中的布局仍可使用。 */
    }
  }, [key, state])
  useEffect(() => {
    const bind = (event: Event) => {
      const detail = (event as CustomEvent<{ hostId: string; from: string; to: string }>).detail
      if (detail.hostId !== host) return
      const from = `pi-meme:sidebar:v1:${JSON.stringify([host, detail.from])}`
      const to = `pi-meme:sidebar:v1:${JSON.stringify([host, detail.to])}`
      setState((value) => {
        if (value.key !== from) return value
        const next = { ...value, key: to }
        try {
          const saved = JSON.parse(localStorage.getItem(to) ?? 'null')
          if (typeof saved?.open === 'boolean' && Number.isFinite(saved.width))
            return { key: to, open: saved.open as boolean, width: Math.max(200, Math.min(420, saved.width)) }
          localStorage.setItem(to, JSON.stringify(next))
        } catch {
          /* 保留内存布局。 */
        }
        return next
      })
    }
    window.addEventListener('pi-meme:workspace-bound', bind)
    return () => window.removeEventListener('pi-meme:workspace-bound', bind)
  }, [host])
  const change = useCallback((open: boolean, width: number) => setState((value) => ({ ...value, open, width })), [])
  return { open: state.open, width: state.width, change }
}
