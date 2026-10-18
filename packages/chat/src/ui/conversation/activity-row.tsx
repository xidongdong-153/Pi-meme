import * as React from 'react'
import type { ActionItemData } from '../model/types'
import { ThinkingActivityRow } from './thinking-activity-row'
import { ToolActivityRow } from './tool-activity-row'
import { NarrationActivityRow } from './narration-activity-row'

export function ActionItemRow({
  item,
  isNested = false,
  className,
}: {
  item: ActionItemData
  isNested?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(item.status === 'running')
  React.useEffect(() => {
    if (item.status === 'running') setOpen(true)
    else setOpen(false)
  }, [item.status])

  if (item.type === 'thinking') {
    return (
      <ThinkingActivityRow
        item={item}
        open={open}
        onToggle={() => setOpen(!open)}
        isNested={isNested}
        isLive={item.status === 'running'}
      />
    )
  }

  if (item.type === 'narration') {
    return <NarrationActivityRow item={item} />
  }

  return (
    <ToolActivityRow
      item={item}
      open={open}
      onToggle={() => setOpen(!open)}
      isNested={isNested}
      className={className}
    />
  )
}
