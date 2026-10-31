import * as React from 'react'
import { cn } from '../../lib/utils'

export type SliderProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>

function clampRatio(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 0
  }
  return Math.min(1, Math.max(0, (value - min) / (max - min)))
}

function resolveInitialValue(defaultValue: SliderProps['defaultValue'], min: number, max: number): number {
  if (defaultValue !== undefined) {
    const parsed = Number(defaultValue)
    if (Number.isFinite(parsed)) return parsed
  }
  return max < min ? min : min + (max - min) / 2
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, style, min = 0, max = 100, value, defaultValue, disabled, onChange, onInput, ...props }, ref) => {
    const minNumber = Number.isFinite(Number(min)) ? Number(min) : 0
    const maxNumber = Number.isFinite(Number(max)) ? Number(max) : 100
    const isControlled = value !== undefined
    const [uncontrolledValue, setUncontrolledValue] = React.useState(() =>
      resolveInitialValue(defaultValue, minNumber, maxNumber),
    )

    const currentValue = isControlled ? Number(value) : uncontrolledValue
    const ratio = clampRatio(currentValue, minNumber, maxNumber)

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) {
        setUncontrolledValue(Number(event.currentTarget.value))
      }
      onChange?.(event)
    }

    const handleInput: React.InputEventHandler<HTMLInputElement> = (event) => {
      if (!isControlled) {
        setUncontrolledValue(Number(event.currentTarget.value))
      }
      onInput?.(event)
    }

    return (
      <div
        className={cn(
          'ui-slider relative inline-flex h-6 w-32 select-none items-center',
          disabled && 'opacity-50',
          className,
        )}
        style={{ ...style, '--slider-progress': String(ratio) } as React.CSSProperties}
      >
        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          onChange={handleChange}
          onInput={handleInput}
          className="ui-slider-input"
          {...props}
        />
        <span aria-hidden="true" className="ui-slider-track">
          <span className="ui-slider-fill" data-empty={ratio <= 0 ? 'true' : undefined} />
        </span>
        <span aria-hidden="true" className="ui-slider-thumb" />
      </div>
    )
  },
)
Slider.displayName = 'Slider'
