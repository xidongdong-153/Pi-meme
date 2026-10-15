import { Sparkles } from 'lucide-react'
import type { PiModel } from '@pi-meme/contracts/pi'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@pi-meme/ui/components/ui/select'

export function ModelSelect({
  models,
  current,
  disabled,
  placeholder,
  onSelect,
}: {
  models: PiModel[]
  current?: PiModel
  disabled: boolean
  placeholder?: string
  onSelect: (model: PiModel) => void
}) {
  const key = (model: PiModel) => JSON.stringify([model.provider, model.id])
  const choices = current && !models.some((model) => key(model) === key(current)) ? [current, ...models] : models
  const currentValue = current ? key(current) : ''

  return (
    <div className="flex items-center min-w-0">
      <Select
        value={currentValue}
        disabled={disabled || !models.length}
        onValueChange={(val) => {
          const model = choices.find((entry) => key(entry) === val)
          if (model) onSelect(model)
        }}
      >
        <SelectTrigger
          aria-label="模型选择"
          className="h-8 min-w-[140px] max-w-[220px] text-xs bg-secondary/50 border-border hover:bg-secondary/80 focus:outline-none gap-1.5"
        >
          <Sparkles className="size-3.5 text-muted-foreground shrink-0" />
          <SelectValue
            placeholder={models.length ? (placeholder ?? '选择模型') : disabled ? '加载模型中...' : '暂无可用模型'}
          />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {choices.map((model) => (
            <SelectItem key={key(model)} value={key(model)} className="text-xs">
              <span className="font-medium text-foreground">{model.provider}</span>
              <span className="text-muted-foreground ml-1.5">/ {model.name ?? model.id}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
