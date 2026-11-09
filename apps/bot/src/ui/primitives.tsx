import { Component } from 'react'
import type { ComponentProps, ErrorInfo, ReactNode } from 'react'
import { Button as ProjectButton } from '@pi-meme/ui/components/ui/button'
import { Input as ProjectInput } from '@pi-meme/ui/components/ui/input'
import { Textarea as ProjectTextarea } from '@pi-meme/ui/components/ui/textarea'
import {
  TooltipContent as ProjectTooltipContent,
  TooltipProvider as ProjectTooltipProvider,
} from '@pi-meme/ui/components/ui/tooltip'
import { AlertCircle } from 'lucide-react'
import { cn } from './utils'

export { Tooltip, TooltipTrigger } from '@pi-meme/ui/components/ui/tooltip'

export function Button({
  className,
  variant = 'default',
  size = 'default',
  type = 'button',
  ...props
}: ComponentProps<'button'> & {
  variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'destructive' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm'
}) {
  return (
    <ProjectButton
      type={type}
      variant={variant}
      size={size}
      className={cn('button', `button-${variant}`, `button-${size}`, className)}
      {...props}
    />
  )
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <ProjectInput className={cn('control', 'input', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <ProjectTextarea className={cn('control', 'textarea', className)} {...props} />
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <ProjectTooltipProvider delayDuration={500} skipDelayDuration={150}>
      {children}
    </ProjectTooltipProvider>
  )
}
export function TooltipContent({ className, sideOffset = 7, ...props }: ComponentProps<typeof ProjectTooltipContent>) {
  return <ProjectTooltipContent className={cn('bot-tooltip', className)} sideOffset={sideOffset} {...props} />
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Bots UI', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    const moduleError = /dynamically imported module|Importing a module script|Loading chunk/i.test(
      this.state.error.message,
    )
    return (
      <main className="auth">
        <AlertCircle size={30} />
        <h1 role="alert">{moduleError ? '页面加载失败' : '页面暂时不可用'}</h1>
        {!moduleError && <p className="error">{this.state.error.message}</p>}
        <Button autoFocus onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </main>
    )
  }
}
