import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useProfiles } from '@/api/profiles'
import { ProfileEditor } from './ProfileEditor'
import { ProfileRestartBanner } from './ProfileRestartBanner'
import { Button } from '@/components/ui/Button'
import { RouteSkeleton } from '@/components/shared/RouteSkeleton'
import { cn } from '@/lib/cn'
import type { ProfileListEntry } from '@/types/domain'

export function ProfilesTab() {
  const profiles = useProfiles()
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showRestartBanner, setShowRestartBanner] = useState(false)

  if (profiles.isPending) return <RouteSkeleton variant="master-detail" />

  const list = profiles.data?.profiles ?? []
  const bootProfile = profiles.data?.current ?? '_base'
  const selectedProfile: ProfileListEntry | null =
    list.find((p) => p.id === selected) ?? null

  return (
    <div className="flex h-full">
      <div className="w-[280px] border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <Button
            size="sm"
            onClick={() => {
              setCreating(true)
              setSelected(null)
            }}
          >
            <Plus size={12} /> New profile
          </Button>
        </div>
        <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-0.5">
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setSelected(p.id)
                setCreating(false)
              }}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-md text-xs',
                selected === p.id && !creating
                  ? 'bg-surface text-fg'
                  : 'text-muted hover:bg-surface hover:text-fg',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{p.id}</span>
                {p.id === bootProfile ? (
                  <span className="text-[9px] uppercase bg-accent/20 text-accent rounded px-1">Active</span>
                ) : null}
                {!p.ok ? <span className="text-[9px] uppercase text-danger">Broken</span> : null}
              </div>
              {p.description ? <div className="text-[10px] truncate">{p.description}</div> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin">
        {showRestartBanner ? <ProfileRestartBanner /> : null}
        {creating ? (
          <ProfileEditor
            profile={null}
            bootProfile={bootProfile}
            onSaved={() => {
              setCreating(false)
            }}
            onCancelled={() => setCreating(false)}
            onRequestRestartBanner={() => setShowRestartBanner(true)}
          />
        ) : selectedProfile ? (
          <ProfileEditor
            key={selectedProfile.id}
            profile={selectedProfile}
            bootProfile={bootProfile}
            onSaved={() => {
              if (selectedProfile.id === bootProfile) setShowRestartBanner(true)
            }}
            onCancelled={() => setSelected(null)}
            onRequestRestartBanner={() => setShowRestartBanner(true)}
          />
        ) : (
          <div className="p-6 text-sm text-muted">Pick a profile to edit, or create a new one.</div>
        )}
      </div>
    </div>
  )
}
