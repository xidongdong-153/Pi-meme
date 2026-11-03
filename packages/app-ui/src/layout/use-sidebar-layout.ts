import { useCallback, useEffect, useState } from 'react'

const storageKey = 'pi-meme:sidebar:v2'

export type SidebarLayout = {
  open: boolean
  width: number
  change: (open: boolean, width: number) => void
}

export function useSidebarLayout(): SidebarLayout {
  const [state, setState] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      if (typeof value?.open === 'boolean' && Number.isFinite(value.width))
        return { open: value.open as boolean, width: Math.max(160, Math.min(600, value.width)) }
    } catch {
      /* 存储不可用时使用默认布局。 */
    }
    return { open: true, width: 256 }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      /* 内存中的布局仍可使用。 */
    }
  }, [state])
  const change = useCallback((open: boolean, width: number) => setState({ open, width }), [])
  return { ...state, change }
}
