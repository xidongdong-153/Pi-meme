import { useState, useSyncExternalStore } from 'react'
import { RotateCcw } from 'lucide-react'
import type { VisualizationDocument } from '@pi-meme/contracts/visualize'
import { Button } from '@pi-meme/ui/components/ui/button'
import { Input } from '@pi-meme/ui/components/ui/input'
import { Switch } from '@pi-meme/ui/components/ui/switch'
import { Slider } from '@pi-meme/ui/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'
import type { VisualizationStateStore } from './visualization-state'

export function VisualizationControls({
  document,
  store,
}: {
  document: VisualizationDocument
  store: VisualizationStateStore
}) {
  const { state } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [error, setError] = useState('')
  const change = (key: string, value: string | number | boolean) => {
    try {
      store.patch({ [key]: value })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">设计参数</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="重置设计状态"
          onClick={() => store.replace(document.initialState)}
        >
          <RotateCcw className="size-4" />
        </Button>
      </div>
      {document.controls.map((control) => (
        <div key={control.key} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words">{control.label}</span>
          {control.type === 'select' ? (
            <Select
              value={String(control.options.findIndex((option) => option.value === state[control.key]))}
              onValueChange={(value) => {
                const option = control.options[Number(value)]
                if (option) change(control.key, option.value)
              }}
            >
              <SelectTrigger aria-label={control.label} className="w-44 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {control.options.map((option, index) => (
                  <SelectItem key={option.value} value={String(index)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : control.type === 'toggle' ? (
            <Switch
              label={control.label}
              checked={Boolean(state[control.key])}
              onChange={(checked) => change(control.key, checked)}
            />
          ) : control.type === 'slider' ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Slider
                aria-label={control.label}
                min={control.min}
                max={control.max}
                step={control.step ?? 1}
                value={Number(state[control.key])}
                onChange={(event) => change(control.key, Number(event.target.value))}
              />
              <output className="text-sm tabular-nums">
                {state[control.key]}
                {control.unit}
              </output>
            </div>
          ) : (
            <Input
              type="color"
              aria-label={control.label}
              className="w-14 p-1"
              value={String(state[control.key])}
              onChange={(event) => change(control.key, event.target.value)}
            />
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
