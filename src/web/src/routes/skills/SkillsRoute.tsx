import { useMemo, useState } from 'react'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { MarkdownView } from '@/components/shared/MarkdownView'
import { useSkills, type SkillListEntry } from '@/api/skills'
import { RouteSkeleton } from '@/components/shared/RouteSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

function filterSkills(list: SkillListEntry[], filter: string): SkillListEntry[] {
  if (!filter) return list
  const term = filter.toLowerCase()
  return list.filter(
    (s) =>
      s.name.toLowerCase().includes(term) ||
      s.category.toLowerCase().includes(term) ||
      s.description.toLowerCase().includes(term),
  )
}

function groupByCategory(list: SkillListEntry[]): [string, SkillListEntry[]][] {
  const map = new Map<string, SkillListEntry[]>()
  for (const s of list) {
    if (!map.has(s.category)) map.set(s.category, [])
    map.get(s.category)!.push(s)
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
}

export function SkillsRoute() {
  const skills = useSkills()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const all = skills.data ?? []
  const visible = useMemo(() => filterSkills(all, filter), [all, filter])
  const grouped = useMemo(() => groupByCategory(visible), [visible])

  if (skills.isPending) return <RouteSkeleton variant="master-detail" />
  if (all.length === 0) {
    return <EmptyState icon={<Sparkles size={36} />} title="No skills loaded" />
  }

  const selectedSkill = all.find((s) => s.qualifiedName === selected) ?? null

  if (selectedSkill) {
    return (
      <SkillDetailView
        all={all}
        filter={filter}
        setFilter={setFilter}
        grouped={grouped}
        selected={selected}
        onSelect={setSelected}
        onBackToGrid={() => setSelected(null)}
        skill={selectedSkill}
      />
    )
  }

  return (
    <SkillGridView
      filter={filter}
      setFilter={setFilter}
      grouped={grouped}
      totalCount={all.length}
      visibleCount={visible.length}
      onSelect={setSelected}
    />
  )
}

interface SkillGridViewProps {
  filter: string
  setFilter(value: string): void
  grouped: [string, SkillListEntry[]][]
  totalCount: number
  visibleCount: number
  onSelect(qualifiedName: string): void
}

function SkillGridView({
  filter,
  setFilter,
  grouped,
  totalCount,
  visibleCount,
  onSelect,
}: SkillGridViewProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-3 md:px-6 py-3 flex flex-wrap items-center gap-2 md:gap-3 shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <Sparkles size={16} className="text-accent" />
          <h1 className="text-sm font-semibold">Skills</h1>
          <span className="text-xs text-muted">
            {filter ? `${visibleCount} of ${totalCount}` : totalCount}
          </span>
        </div>
        <div className="hidden md:block flex-1" />
        <div className="w-full md:w-72">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter skills"
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin px-3 md:px-6 py-4">
        {visibleCount === 0 ? (
          <EmptyState
            title="No skills match"
            body={`Nothing matches "${filter}". Clear the filter to see all skills.`}
          />
        ) : (
          <div className="space-y-6">
            {grouped.map(([category, list]) => (
              <div key={category}>
                <div className="text-[10px] uppercase text-muted font-semibold mb-2">
                  {category}{' '}
                  <span className="text-muted/70 font-normal normal-case">({list.length})</span>
                </div>
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
                  {list.map((s) => (
                    <SkillTile key={s.qualifiedName} skill={s} onClick={() => onSelect(s.qualifiedName)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SkillTile({ skill, onClick }: { skill: SkillListEntry; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left bg-surface border border-border rounded-lg p-3 transition-colors',
        'hover:border-accent/40 hover:bg-accent/5 focus:outline-none focus:ring-2 focus:ring-accent',
        'flex flex-col gap-1.5 min-h-[96px]',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate flex-1">{skill.name}</span>
        {skill.slashCommand ? (
          <span className="text-[10px] font-mono text-accent shrink-0">/{skill.slashCommand}</span>
        ) : null}
      </div>
      <div className="text-[11px] text-muted line-clamp-2">{skill.description}</div>
      {skill.allowedTools.length > 0 ? (
        <div className="mt-auto text-[10px] text-muted">
          {skill.allowedTools.length} tool{skill.allowedTools.length === 1 ? '' : 's'}
        </div>
      ) : null}
    </button>
  )
}

interface SkillDetailViewProps {
  all: SkillListEntry[]
  filter: string
  setFilter(value: string): void
  grouped: [string, SkillListEntry[]][]
  selected: string | null
  onSelect(qualifiedName: string): void
  onBackToGrid(): void
  skill: SkillListEntry
}

function SkillDetailView({
  filter,
  setFilter,
  grouped,
  selected,
  onSelect,
  onBackToGrid,
  skill,
}: SkillDetailViewProps) {
  return (
    <div className="flex h-full">
      {/* List sidebar — hidden on mobile (the detail takes over the full surface). */}
      <div className="hidden md:flex w-[280px] border-r border-border flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <button
            type="button"
            onClick={onBackToGrid}
            className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-fg"
            title="Back to all skills"
          >
            <ArrowLeft size={12} /> All skills
          </button>
        </div>
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
                    onClick={() => onSelect(s.qualifiedName)}
                    className={cn(
                      'w-full text-left px-2 py-1.5 rounded-md text-xs',
                      selected === s.qualifiedName
                        ? 'bg-surface text-fg'
                        : 'text-muted hover:bg-surface hover:text-fg',
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
      <div className="flex-1 overflow-auto scrollbar-thin min-w-0">
        {/* Mobile-only back link — desktop has the same affordance in the left rail. */}
        <div className="md:hidden border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={onBackToGrid}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
          >
            <ArrowLeft size={12} /> All skills
          </button>
        </div>
        <div className="p-4 md:p-6 max-w-3xl">
          <div className="mb-4">
            <div className="text-[10px] uppercase text-muted">{skill.category}</div>
            <h1 className="text-lg font-semibold break-words">{skill.name}</h1>
            <p className="text-sm text-muted mt-1">{skill.description}</p>
            {skill.allowedTools.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {skill.allowedTools.map((t) => (
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
            <MarkdownView content={skill.body} />
          </div>
        </div>
      </div>
    </div>
  )
}
