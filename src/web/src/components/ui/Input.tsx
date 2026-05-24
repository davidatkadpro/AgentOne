import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

// text-base on small bumps font-size to 16px which prevents iOS Safari's
// auto-zoom-on-focus when a touch input is tapped.
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-bg px-2 text-base md:text-sm text-fg',
        'placeholder:text-muted',
        'focus:outline-none focus:ring-2 focus:ring-accent',
        className,
      )}
      {...rest}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-md border border-border bg-bg p-2 text-base md:text-sm text-fg',
          'placeholder:text-muted resize-none overflow-y-auto scrollbar-thin',
          'focus:outline-none focus:ring-2 focus:ring-accent',
          className,
        )}
        {...rest}
      />
    )
  },
)
