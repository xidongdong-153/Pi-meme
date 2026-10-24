import { Box } from 'lucide-react'
import type { PiModel } from '@pi-meme/contracts/pi'
import type { TurnChunk } from '../model/types'

type ModelChange = Extract<TurnChunk, { type: 'model_change' }>

export function ModelChangeRow({
  from,
  to,
  models,
}: Pick<ModelChange, 'from' | 'to'> & { models: readonly PiModel[] }) {
  const name = (model: ModelChange['to']) =>
    models.find((item) => item.provider === model.provider && item.id === model.id)?.name?.trim() || model.id
  let fromName = from ? name(from) : undefined
  let toName = name(to)
  if (from && fromName === toName) {
    fromName = `${from.provider}/${from.id}`
    toName = `${to.provider}/${to.id}`
  }
  const label = fromName ? `模型已从 ${fromName} 更改为 ${toName}。` : `模型已更改为 ${toName}。`

  return (
    <div className="flex w-full min-w-0 items-center gap-3 py-2 text-xs text-muted-foreground" title={label}>
      <span className="h-px min-w-0 flex-1 bg-border/70" aria-hidden="true" />
      <div className="flex min-w-0 max-w-full items-start justify-center gap-2">
        <Box className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 text-center leading-5 [overflow-wrap:anywhere]">
          {fromName ? (
            <>
              模型已从 {fromName} 更改为 {toName}。
            </>
          ) : (
            <>模型已更改为 {toName}。</>
          )}
        </span>
      </div>
      <span className="h-px min-w-0 flex-1 bg-border/70" aria-hidden="true" />
    </div>
  )
}
