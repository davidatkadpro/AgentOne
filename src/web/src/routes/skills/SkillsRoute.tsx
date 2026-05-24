import { useMemo, useState } from 'react'
import { MarkdownView } from '@/components/shared/MarkdownView'
import { useSkills, type SkillListEntry } from '@/api/skills'
import { RouteSkeleton } from '@/components/shared/RouteSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Input } from '@/components/ui/Input'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'

export function SkillsRoute() {
  const skills = useSkills()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const grouped = useMemo(() => {
    const list = (skills.data ?? []).filter((s) => {
      if (!filter) return true
      const term = filter.toLowerCase()
      return (
        s.name.toLowerCase().includes(term) ||
        s.category.toLowerCase().includes(term) ||
        s.description.toLowerCase().includes(term)
      )
    })
    const map = new Map<string, SkillListEntry[]>()
    for (const s of list) {
      if (!map.has(s.category)) map.set(s.category, [])
      map.get(s.category)!.push(s)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [skills.data, filter])

  const selectedSkill = (skills.data ?? []).find((s) => s.qualifiedName === selected)

  if (skills.isPending) return <RouteSkeleton variant="master-detail" />
  if (!skills.data || skills.data.length === 0) {
    return <EmptyState icon={<Sparkles size={36} />} title="No skills loaded" />
  }

  return (
    <div className="flex h-full">
      <div className="w-[360px] border-r border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter skills"
          />
        </div>
        <div className="flex-1 overflow-auto scrollbar-thin p-2 space-y-3">
          {grouped.map(([category, list]) => (
            <div key={category}>
              <div className="px-2 text-[10px] uppercase text-muted mb-1">{category}</div>
              <div className="space-y-0.5">
                {list.map((s) => (
                  <button
                    key={s.qualifiedName}
                    onClick={() => setSelected(s.qualifiedName)}
                    className={cn(
                      'w-full text-left px-2 py-1.5 rounded-md text-xs',
                      selected === s.qualifiedName ? 'bg-surface text-fg' : 'text-muted hover:bg-surface hover:text-fg',
                    )}
                  >
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[10px] truncate">{s.description}</div>
                    {s.slashCommand ? (
                      <div className="text-[10px] font-mono text-accent">/{s.slashCommand}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin">
        {selectedSkill ? (
          <div className="p-6 max-w-3xl">
            <div className="mb-4">
              <div className="text-[10px] uppercase text-muted">{selectedSkill.category}</div>
              <h1 className="text-lg font-semibold">{selectedSkill.name}</h1>
              <p className="text-sm text-muted mt-1">{selectedSkill.description}</p>
              {selectedSkill.allowedTools.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selectedSkill.allowedTools.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] font-mono bg-surface border border-border rounded px-1.5 py-0.5"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="prose-sm">
              <MarkdownView content={selectedSkill.body} />
            </div>
          </div>
        ) : (
          <EmptyState title="Select a skill" body="Choose a skill from the list to view its full definition." />
        )}
      </div>
    </div>
  )
}
