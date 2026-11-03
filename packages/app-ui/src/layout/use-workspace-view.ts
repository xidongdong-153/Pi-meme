import { useEffect, useState } from 'react'

const storageKey = 'pi-meme:workspace-view:v1'

export type WorkspaceView = {
  unified: boolean
  change: (unified: boolean) => void
}

export function useWorkspaceView(): WorkspaceView {
  const [unified, setUnified] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === 'unified'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, unified ? 'unified' : 'split')
    } catch {
      /* 存储不可用时仍可切换视图。 */
    }
  }, [unified])
  return { unified, change: setUnified }
}
