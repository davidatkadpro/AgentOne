import { cn } from '@/lib/cn'

export interface AgentAvatarProps {
  /** Agent profile id — first letter is rendered. */
  profile: string | null | undefined
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS: Record<NonNullable<AgentAvatarProps['size']>, string> = {
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
  lg: 'w-10 h-10 text-sm',
}

export function AgentAvatar({ profile, size = 'sm', className }: AgentAvatarProps) {
  const letter = (profile?.trim()[0] ?? '?').toUpperCase()
  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-full font-semibold uppercase select-none shrink-0',
        'bg-accent/15 text-accent border border-accent/20',
        SIZE_CLASS[size],
        className,
      )}
      aria-hidden
    >
      {letter}
    </div>
  )
}
