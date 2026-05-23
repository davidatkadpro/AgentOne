import { useUiStore } from '@/stores/ui'
import { cn } from '@/lib/cn'

export function ThemeTab() {
  const { theme, setTheme } = useUiStore()
  const options: Array<{ id: 'light' | 'dark' | 'system'; label: string; body: string }> = [
    { id: 'light', label: 'Light', body: 'Always light, regardless of system.' },
    { id: 'dark', label: 'Dark', body: 'Always dark, regardless of system.' },
    { id: 'system', label: 'System', body: 'Follow the OS dark-mode preference.' },
  ]
  return (
    <div className="p-6 max-w-xl space-y-2">
      <h2 className="text-base font-semibold mb-2">Theme</h2>
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => setTheme(opt.id)}
          className={cn(
            'w-full text-left p-3 rounded-md border',
            theme === opt.id ? 'bg-surface border-accent' : 'bg-bg border-border hover:bg-surface',
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'w-3 h-3 rounded-full border-2',
                theme === opt.id ? 'bg-accent border-accent' : 'border-border',
              )}
            />
            <div>
              <div className="text-sm font-medium text-fg">{opt.label}</div>
              <div className="text-xs text-muted">{opt.body}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
