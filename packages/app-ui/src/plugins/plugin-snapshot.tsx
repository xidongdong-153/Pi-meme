import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { UiReactiveMetadata } from '@pi-meme/contracts/plugin-ui-data'
import type { UiExternalStore } from '@pi-meme/plugin-sdk/reactive'
import type { UiContributionProps } from '@pi-meme/plugin-sdk/ui'

const PluginSnapshotContext = createContext<UiExternalStore<UiReactiveMetadata> | null>(null)

export function PluginSnapshotProvider({
  source,
  children,
}: {
  source: UiExternalStore<UiReactiveMetadata>
  children: ReactNode
}) {
  return <PluginSnapshotContext value={source}>{children}</PluginSnapshotContext>
}

function noSubscription() {
  return () => {}
}

function noSnapshot() {
  return null
}

/** 插件回调也可能通过注册上下文读取完整 metadata，保留这些叶子的实时通知。 */
export function usePluginMetadata(enabled = true) {
  const source = useContext(PluginSnapshotContext)
  const metadata = useSyncExternalStore(
    enabled ? (source?.subscribe ?? noSubscription) : noSubscription,
    enabled ? (source?.getSnapshot ?? noSnapshot) : noSnapshot,
    enabled ? (source?.getSnapshot ?? noSnapshot) : noSnapshot,
  )
  return { source, metadata }
}

/** 实时快照只通知实际插件叶子；保留面板不接收其他会话的快照。 */
export function usePluginSnapshot(props: UiContributionProps): UiContributionProps {
  const { source, metadata } = usePluginMetadata()
  const hostId = props.target.hostId
  const projectId = props.target.project?.projectId
  const sessionId = props.target.session?.sessionId
  const fallback = props.snapshot
  const selectSnapshot = useMemo(() => {
    let selected = fallback
    return (current: UiReactiveMetadata | null) => {
      if (
        current &&
        current.target.hostId === hostId &&
        current.target.project?.projectId === projectId &&
        current.target.session?.sessionId === sessionId
      )
        selected = current.session
      return selected
    }
  }, [source, hostId, projectId, sessionId, fallback])
  const snapshot = selectSnapshot(metadata)
  return snapshot === props.snapshot ? props : { ...props, snapshot }
}
