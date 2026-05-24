import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { ProfilesTab } from './ProfilesTab'
import { ThemeTab } from './ThemeTab'
import { HooksTab } from './HooksTab'
import { IntegrationsTab } from './IntegrationsTab'

const TABS = [
  { id: 'profiles', label: 'Profiles' },
  { id: 'theme', label: 'Theme' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'integrations', label: 'Integrations' },
] as const

type TabId = (typeof TABS)[number]['id']

function isTab(value: string | null): value is TabId {
  return value === 'profiles' || value === 'theme' || value === 'hooks' || value === 'integrations'
}

export function SettingsRoute() {
  const [search, setSearch] = useSearchParams()
  const queryTab = search.get('tab')
  const tab: TabId = isTab(queryTab) ? queryTab : 'profiles'

  useEffect(() => {
    if (!queryTab) {
      const next = new URLSearchParams(search)
      next.set('tab', 'profiles')
      setSearch(next, { replace: true })
    }
  }, [queryTab, search, setSearch])

  function setTab(id: TabId) {
    const next = new URLSearchParams(search)
    next.set('tab', id)
    setSearch(next, { replace: true })
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-3 md:px-6 overflow-x-auto scrollbar-thin">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-3 py-2 text-xs font-medium border-b-2 -mb-px',
                tab === t.id
                  ? 'border-accent text-fg'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin">
        {tab === 'profiles' ? <ProfilesTab /> : null}
        {tab === 'theme' ? <ThemeTab /> : null}
        {tab === 'hooks' ? <HooksTab /> : null}
        {tab === 'integrations' ? <IntegrationsTab /> : null}
      </div>
    </div>
  )
}
