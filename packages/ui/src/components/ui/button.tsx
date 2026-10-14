import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,opacity,scale] duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 select-none cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:opacity-90 active:scale-[0.98]',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:opacity-90 active:scale-[0.98]',
        outline:
          'border border-border bg-transparent shadow-sm hover:bg-secondary hover:text-foreground active:scale-[0.98]',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:scale-[0.98]',
        ghost: 'hover:bg-secondary hover:text-foreground active:scale-[0.98]',
        link: 'text-primary underline-offset-4 hover:underline cursor-pointer',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-7 rounded-sm px-2 text-xs',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'size-8 rounded-md',
        'icon-sm': 'size-7 rounded-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => {
    return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  },
)
Button.displayName = 'Button'
