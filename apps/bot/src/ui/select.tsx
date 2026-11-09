import { Children, Fragment, isValidElement, useId, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from 'react'
import {
  Select as ProjectSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pi-meme/ui/components/ui/select'
import { cn } from './utils'

type Option = { value: string; label: ReactNode; text: string; disabled: boolean }
type OptionProps = {
  value?: string | number
  children?: ReactNode
  label?: string
  disabled?: boolean
  hidden?: boolean
}

function optionText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      return isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : ''
    })
    .join('')
}

function optionsFromChildren(children: ReactNode, inheritedDisabled = false): Option[] {
  const options: Option[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement<OptionProps>(child)) return
    if (child.type === Fragment || child.type === 'optgroup') {
      options.push(...optionsFromChildren(child.props.children, inheritedDisabled || Boolean(child.props.disabled)))
    } else if (child.type === 'option' && !child.props.hidden) {
      const text = child.props.label ?? optionText(child.props.children)
      options.push({
        value: child.props.value === undefined ? text : String(child.props.value),
        label: child.props.label ?? child.props.children,
        text,
        disabled: inheritedDisabled || Boolean(child.props.disabled),
      })
    }
  })
  return options
}

function keepComposition(event: KeyboardEvent) {
  if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation()
}

type SelectProps = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'className' | 'name'
> & {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  required?: boolean
  disabled?: boolean
}

/** Keeps the existing option-based API while the project Select owns interaction and form participation. */
export function Select({
  id,
  value,
  onChange,
  children,
  required = false,
  disabled = false,
  className,
  name,
  'aria-describedby': describedBy,
  ...ariaProps
}: SelectProps) {
  const localId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [invalid, setInvalid] = useState(false)
  const options = optionsFromChildren(children)
  const placeholder = options.find((option) => option.value === '')
  let emptyItemValue = `${localId}-empty-option`
  while (options.some((option) => option.value === emptyItemValue)) emptyItemValue += '-'
  const errorId = `${localId}-error`
  return (
    <span
      className="bot-select"
      onInvalidCapture={(event) => {
        // Radix's own form select supplies native required validation; focus its visible trigger on failure.
        event.preventDefault()
        setInvalid(true)
        const control = event.target as HTMLSelectElement
        const firstInvalid = control.form?.querySelector('input:invalid, select:invalid, textarea:invalid')
        if (!firstInvalid || firstInvalid === control) trigger.current?.focus()
      }}
    >
      <ProjectSelect
        value={value}
        required={required}
        disabled={disabled}
        name={name}
        onValueChange={(nextValue) => {
          setInvalid(false)
          onChange(nextValue === emptyItemValue ? '' : nextValue)
        }}
      >
        <SelectTrigger
          {...ariaProps}
          ref={trigger}
          id={id ?? localId}
          className={cn('control', 'bot-select-trigger', className)}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, invalid && errorId].filter(Boolean).join(' ') || undefined}
          onKeyDownCapture={keepComposition}
        >
          <SelectValue placeholder={placeholder?.label ?? '请选择'} />
        </SelectTrigger>
        <SelectContent
          className="bot-select-content"
          onKeyDownCapture={keepComposition}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault()
          }}
          collisionPadding={12}
        >
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value === '' ? emptyItemValue : option.value}
              disabled={option.disabled}
              textValue={option.text}
              className="bot-select-item"
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </ProjectSelect>
      {invalid && (
        <span id={errorId} className="bot-select-error error" role="alert">
          请选择一项。
        </span>
      )}
    </span>
  )
}
