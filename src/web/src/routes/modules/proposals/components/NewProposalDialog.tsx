import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import {
  useCreateEstimate,
  useProposalTemplates,
  useScopeFiles,
} from '@/api/proposals'
import { useProjects } from '@/api/projects'
import { api } from '@/lib/api'
import type { DispatchModuleActionResponse } from '@/types/api'

export interface NewProposalDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  defaultProjectId?: string
  /** Navigate to the new estimate once it lands. */
  onCreated(estimateId: string): void
}

type Tab = 'from-scope' | 'blank'

export function NewProposalDialog({
  open,
  onOpenChange,
  defaultProjectId,
  onCreated,
}: NewProposalDialogProps) {
  const projects = useProjects()
  const templates = useProposalTemplates()
  const [tab, setTab] = useState<Tab>('from-scope')
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? '')
  const [templateName, setTemplateName] = useState<string>('')
  const [scopeFilePath, setScopeFilePath] = useState<string>('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? '')
      setScopeFilePath('')
      setSearch('')
      setTab('from-scope')
    }
  }, [open, defaultProjectId])

  useEffect(() => {
    if (templates.data && !templateName) {
      const first = templates.data.find((t) => t.name === 'default') ?? templates.data[0]
      if (first) setTemplateName(first.name)
    }
  }, [templates.data, templateName])

  const scopeFiles = useScopeFiles(projectId || null)
  const createEstimate = useCreateEstimate(projectId)

  const filteredProjects = (projects.data ?? []).filter((p) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      p.number.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      (p.client ?? '').toLowerCase().includes(q)
    )
  })

  async function handleBuildFromScope(): Promise<void> {
    if (!projectId || !scopeFilePath) return
    try {
      const res = await api.post<DispatchModuleActionResponse>('/proposals/actions', {
        action: 'build-estimate',
        contextId: projectId,
        args: { scopeFilePath, templateName: templateName || 'default' },
      })
      toast.success('Estimate-building session spawned.')
      onOpenChange(false)
      // The action returns a sessionId; the eventual estimate.created event
      // shows up in the list via WS. For now leave the list view to surface it.
      void res
    } catch (err) {
      toast.error(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleStartBlank(): Promise<void> {
    if (!projectId) return
    try {
      const res = await createEstimate.mutateAsync({
        templateName: templateName || 'default',
        lines: [],
      })
      onCreated(res.estimate.id)
      onOpenChange(false)
    } catch {
      // Toast already fired in mutation onError.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New proposal">
      <div className="flex flex-col gap-3 text-xs">
        {/* Template picker */}
        <label className="flex flex-col gap-1">
          <span className="text-muted">Template</span>
          <select
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            data-testid="new-proposal-template"
            className="h-8 bg-bg border border-border rounded px-2"
          >
            {(templates.data ?? []).map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} {t.source === 'override' ? '(override)' : ''}
              </option>
            ))}
            {templates.data && templates.data.length === 0 ? (
              <option value="default">default</option>
            ) : null}
          </select>
        </label>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'from-scope'}
            data-testid="new-proposal-tab-from-scope"
            onClick={() => setTab('from-scope')}
            className={
              tab === 'from-scope'
                ? 'px-2 py-1 text-xs border-b-2 border-accent text-fg font-medium -mb-px'
                : 'px-2 py-1 text-xs border-b-2 border-transparent text-muted hover:text-fg'
            }
          >
            Build from scope
          </button>
          <button
            role="tab"
            aria-selected={tab === 'blank'}
            data-testid="new-proposal-tab-blank"
            onClick={() => setTab('blank')}
            className={
              tab === 'blank'
                ? 'px-2 py-1 text-xs border-b-2 border-accent text-fg font-medium -mb-px'
                : 'px-2 py-1 text-xs border-b-2 border-transparent text-muted hover:text-fg'
            }
          >
            Start blank
          </button>
        </div>

        {/* Project picker */}
        <label className="flex flex-col gap-1">
          <span className="text-muted">Project</span>
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
            data-testid="new-proposal-project-search"
          />
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            data-testid="new-proposal-project"
            className="h-8 bg-bg border border-border rounded px-2"
          >
            <option value="">— pick a project —</option>
            {filteredProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.number} — {p.name}
              </option>
            ))}
          </select>
        </label>

        {tab === 'from-scope' ? (
          <label className="flex flex-col gap-1">
            <span className="text-muted">Scope file</span>
            <select
              value={scopeFilePath}
              onChange={(e) => setScopeFilePath(e.target.value)}
              disabled={!projectId || scopeFiles.isLoading}
              data-testid="new-proposal-scope-file"
              className="h-8 bg-bg border border-border rounded px-2 disabled:opacity-50"
            >
              <option value="">
                {scopeFiles.isLoading
                  ? 'Loading…'
                  : (scopeFiles.data ?? []).length === 0
                    ? '— no scope.md files —'
                    : '— pick a scope.md —'}
              </option>
              {(scopeFiles.data ?? []).map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex justify-end gap-2 mt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="new-proposal-cancel"
          >
            Cancel
          </Button>
          {tab === 'from-scope' ? (
            <Button
              size="sm"
              disabled={!projectId || !scopeFilePath}
              onClick={() => void handleBuildFromScope()}
              data-testid="new-proposal-generate"
            >
              Generate estimate
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!projectId || createEstimate.isPending}
              onClick={() => void handleStartBlank()}
              data-testid="new-proposal-blank-create"
            >
              Create empty estimate
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
