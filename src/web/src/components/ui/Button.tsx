import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:opacity-90',
  secondary: 'bg-surface border border-border text-fg hover:bg-bg',
  ghost: 'text-fg hover:bg-surface',
  danger: 'bg-danger text-white hover:opacity-90',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs rounded-md',
  md: 'h-9 px-3 text-sm rounded-md',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1 font-medium transition-colors',
        'disabled:opacity-50 disabled:pointer-events-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  )
})
