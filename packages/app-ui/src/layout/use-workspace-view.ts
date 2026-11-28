import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformAdapter } from '@pi-meme/contracts/host'

const storageKey = 'pi-meme:workspace-view:v1'

export type WorkspaceView = {
  unified: boolean
  change: (unified: boolean) => void
}

function readBrowserView(): boolean | null {
  try {
    const view = localStorage.getItem(storageKey)
    if (view === 'unified') return true
    if (view === 'split') return false
  } catch {
    /* 存储不可用时仍可切换视图。 */
  }
  return null
}

export function useWorkspaceView(storage?: PlatformAdapter['workspaceView']) {
  const [unified, setUnified] = useState<boolean | null>(() => (storage ? null : (readBrowserView() ?? false)))
  const [error, setError] = useState('')
  const writeRevision = useRef(0)

  const change = useCallback(
    async (next: boolean) => {
      const revision = ++writeRevision.current
      setUnified(next)
      setError('')
      try {
        if (storage) await storage.save(next)
        else localStorage.setItem(storageKey, next ? 'unified' : 'split')
      } catch (cause) {
        if (revision === writeRevision.current) setError(`无法保存完整视图设置：${String(cause)}`)
      }
    },
    [storage],
  )

  useEffect(() => {
    if (!storage) return
    let current = true
    void storage.read().then(
      (saved) => {
        if (!current) return
        const legacy = saved === null ? readBrowserView() : null
        if (legacy !== null) void change(legacy)
        else setUnified(saved ?? false)
      },
      (cause: unknown) => {
        if (!current) return
        setUnified(readBrowserView() ?? false)
        setError(`无法读取完整视图设置：${String(cause)}`)
      },
    )
    return () => {
      current = false
    }
  }, [storage, change])

  return { unified: unified ?? false, ready: unified !== null, change, error, dismissError: () => setError('') }
}
