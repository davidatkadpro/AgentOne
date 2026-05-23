import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { EmptyState } from '@/components/shared/EmptyState'
import { ActionToolbar } from '@/components/module/ActionToolbar'
import { AskAgentMenu } from '@/components/module/AskAgentMenu'
import { InlineSessionStream } from '@/components/module/InlineSessionStream'
import { useProject, useProjectBudget, useUpdateProjectStatus } from '@/api/projects'
import { useCreateSession } from '@/api/sessions'
import { useModuleActions } from '@/api/module-actions'
import { ProjectHeaderStrip } from './components/ProjectHeaderStrip'
import { useProjectDeepLink, type ProjectTab } from './hooks/useProjectDeepLink'
import { TasksTab } from './components/tabs/TasksTab'
import { ScopeTab } from './components/tabs/ScopeTab'
import { FilesTab } from './components/tabs/FilesTab'
import { ActivityTab } from './components/tabs/ActivityTab'
import { DraftsTab } from './components/tabs/DraftsTab'
import { EmailsTab } from './components/tabs/EmailsTab'
import { PlaceholderTab } from './components/tabs/PlaceholderTab'

const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'scope', label: 'Scope' },
  { id: 'emails', label: 'Emails' },
  { id: 'files', label: 'Files' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'activity', label: 'Activity' },
]

export interface ProjectDetailRouteProps {
  projectId: string
}

export function ProjectDetailRoute({ projectId }: ProjectDetailRouteProps) {
  const navigate = useNavigate()
  const detail = useProject(projectId)
  const budget = useProjectBudget(projectId)
  const updateStatus = useUpdateProjectStatus(projectId)
  const createSession = useCreateSession()
  const actions = useModuleActions('projects')
  const link = useProjectDeepLink()
  const [dispatchedSessionId, setDispatchedSessionId] = useState<string | null>(null)
  const [streamOpen, setStreamOpen] = useState(true)

  if (detail.isLoading) {
    return <div className="p-4 text-xs text-muted">Loading project…</div>
  }
  if (!detail.data) {
    return <EmptyState title="Project not found" body="The project may have been deleted." />
  }
  const project = detail.data.project
  const folderUrl = project.folderPath

  return (
    <div className="flex flex-col h-full">
      <ProjectHeaderStrip
        project={project}
        budget={budget.data ?? null}
        rootPath={folderUrl}
        onStatusChange={(s) => void updateStatus.mutate({ status: s })}
        onOpenInChat={() => {
          void createSession
            .mutateAsync({
              title: `Project ${project.number} — ${project.name}`,
              seed: {
                spawnedBy: `projects/${project.id}`,
                initialMessage: `Working on project ${project.number} (${project.name}). What do you need to know?`,
              },
            })
            .then((res) => navigate(`/chat/${res.session.id}`))
        }}
      />
      <div className="border-b border-border px-3 py-1.5 flex items-center gap-2">
        <ActionToolbar
          module="projects"
          contextId={projectId}
          actions={actions.data?.actions ?? []}
          errors={actions.data?.errors ?? []}
          onDispatched={(_action, sessionId) => setDispatchedSessionId(sessionId)}
        />
      </div>
      {dispatchedSessionId ? (
        <div className="border-b border-border px-3 py-2">
          <InlineSessionStream
            sessionId={dispatchedSessionId}
            open={streamOpen}
            onOpenChange={setStreamOpen}
          />
        </div>
      ) : null}
      <div className="border-b border-border px-3 flex items-center gap-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={link.tab === t.id}
            onClick={() => link.setTab(t.id)}
            data-testid={`project-tab-${t.id}`}
            className={cn(
              'h-9 px-2 text-xs border-b-2 -mb-px transition-colors',
              link.tab === t.id
                ? 'border-accent text-fg font-medium'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <AskAgentMenu
          module="projects"
          tab={link.tab}
          contextId={projectId}
          skills={actions.data?.actions ?? []}
          onDispatched={(_action, sessionId) => setDispatchedSessionId(sessionId)}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {link.tab === 'tasks' ? (
          <TasksTab
            projectId={projectId}
            openTaskId={link.taskId}
            onOpenTask={(id) => (id ? link.open(id) : link.close())}
          />
        ) : link.tab === 'scope' ? (
          <ScopeTab projectId={projectId} />
        ) : link.tab === 'files' ? (
          <FilesTab projectId={projectId} />
        ) : link.tab === 'drafts' ? (
          <DraftsTab projectId={projectId} />
        ) : link.tab === 'activity' ? (
          <ActivityTab projectId={projectId} />
        ) : link.tab === 'emails' ? (
          <EmailsTab projectId={projectId} />
        ) : link.tab === 'proposals' ? (
          <PlaceholderTab module="proposals" phase={4} />
        ) : (
          <PlaceholderTab module="invoicing" phase={5} />
        )}
      </div>
    </div>
  )
}
