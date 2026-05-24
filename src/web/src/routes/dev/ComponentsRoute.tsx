import { useState } from 'react'
import { Calendar, Mail, FilePlus, Trash2 } from 'lucide-react'
import { ActionToolbar } from '@/components/module/ActionToolbar'
import { AskAgentMenu } from '@/components/module/AskAgentMenu'
import { KpiStrip } from '@/components/module/KpiStrip'
import { ModulePanel } from '@/components/module/ModulePanel'
import { StatusActionButton } from '@/components/module/StatusActionButton'
import { EmptyState } from '@/components/shared/EmptyState'
import { ToolChip } from '@/routes/chat/ToolChip'
import { InvoiceStatusBadge } from '@/routes/modules/invoicing/components/InvoiceStatusBadge'
import { SyncStatusBadge } from '@/routes/modules/invoicing/components/SyncStatusBadge'
import type { ModuleAction } from '@/types/domain'

/**
 * Dev-only sandbox for the five shared module components plus a handful of
 * primitives we built along the way. Mounted at `/__dev/components` when
 * `import.meta.env.DEV` is true; tree-shaken out of production builds.
 *
 * The point is *isolated rendering* with fixture data — not a regression
 * harness. Each section pins the props the consumer routes pass; if the
 * fixture stops rendering, the component contract broke. Storybook would
 * be the next step if the surface area justifies it (~20 components).
 */

const mockActions: ModuleAction[] = [
  {
    name: 'build-estimate',
    label: 'Build estimate',
    description: 'Draft an estimate from a scope file.',
    icon: 'wand',
    surface: 'both',
    tabs: [],
    defaultProfile: 'ops',
    requiresConfirmation: false,
  },
  {
    name: 'generate-proposal',
    label: 'Generate proposal',
    description: 'Roll an accepted estimate into a proposal.',
    icon: 'file-text',
    surface: 'action',
    tabs: [],
    defaultProfile: 'ops',
    requiresConfirmation: true,
  },
  {
    name: 'reconcile-drift',
    label: 'Reconcile drift',
    description: 'Walk the operator through a drifted QBO invoice.',
    icon: 'refresh-cw',
    surface: 'ask_agent',
    tabs: [],
    defaultProfile: 'ops',
    requiresConfirmation: false,
  },
]

const mockKpiPills = [
  { id: 'todo', label: 'To do', count: 5 },
  { id: 'in_progress', label: 'In progress', count: 2, tone: 'warn' as const },
  { id: 'done', label: 'Done', count: 18 },
]

const issueTransitions = {
  draft: {
    primary: { label: 'Mark issued', onClick: () => console.log('issued') },
    secondary: [{ label: 'Discard', onClick: () => console.log('discarded') }],
  },
  issued: {
    primary: { label: 'Mark accepted', onClick: () => console.log('accepted') },
    secondary: [{ label: 'Mark rejected', onClick: () => console.log('rejected') }],
  },
  accepted: {
    primary: { label: 'Accepted', onClick: () => {}, disabled: true },
    secondary: [],
  },
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-border rounded-md" data-testid={`dev-section-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="px-3 py-2 border-b border-border bg-surface text-xs font-semibold">
        {title}
      </div>
      <div className="p-4 space-y-3">{children}</div>
    </section>
  )
}

export function ComponentsRoute() {
  const [activePill, setActivePill] = useState<string | null>('in_progress')
  const [status, setStatus] = useState<keyof typeof issueTransitions>('draft')

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" data-testid="dev-components-route">
      <header>
        <h1 className="text-lg font-semibold">Module components sandbox</h1>
        <p className="text-xs text-muted mt-1">
          Dev-only. Isolated render harness for M1–M5 + shared primitives.
        </p>
      </header>

      <Section title="M1 ActionToolbar">
        <ActionToolbar
          module="proposals"
          contextId="fixture-1"
          actions={mockActions.filter((a) => a.surface !== 'ask_agent')}
          onDispatched={(action, sid) => console.log('dispatched', action, sid)}
        />
        <p className="text-[10px] text-muted">
          Renders `surface in (action, both)`. `requires_confirmation` shows an
          AlertDialog before dispatch.
        </p>
      </Section>

      <Section title="M3 AskAgentMenu">
        <div className="flex">
          <AskAgentMenu
            module="proposals"
            tab=""
            contextId="fixture-1"
            skills={mockActions}
            onDispatched={(action, sid) => console.log('asked agent', action, sid)}
          />
        </div>
        <p className="text-[10px] text-muted">
          Filters by `surface in (ask_agent, both)` + tab membership.
        </p>
      </Section>

      <Section title="M4 KpiStrip">
        <KpiStrip
          pills={mockKpiPills}
          activePillId={activePill}
          onPillClick={(id) => setActivePill(activePill === id ? null : id)}
        />
        <p className="text-[10px] text-muted">
          Active pill: <span className="font-mono">{activePill ?? '<none>'}</span>
        </p>
      </Section>

      <Section title="M5 StatusActionButton">
        <div className="flex items-center gap-3">
          <span className="text-xs">Status:</span>
          <code className="font-mono text-xs">{status}</code>
          <StatusActionButton
            status={status}
            transitions={{
              draft: {
                primary: { label: 'Mark issued', onClick: () => setStatus('issued') },
                secondary: [{ label: 'Discard', onClick: () => setStatus('draft') }],
              },
              issued: {
                primary: { label: 'Mark accepted', onClick: () => setStatus('accepted') },
                secondary: [{ label: 'Move to draft', onClick: () => setStatus('draft') }],
              },
              accepted: {
                primary: { label: 'Accepted', onClick: () => {}, disabled: true },
                secondary: [{ label: 'Reopen', onClick: () => setStatus('draft') }],
              },
            }}
          />
        </div>
        <p className="text-[10px] text-muted">
          Three-state machine. Primary is the happy-path move; overflow has the
          side moves.
        </p>
      </Section>

      <Section title="ModulePanel + EmptyState">
        <div className="h-72 border border-border rounded">
          <ModulePanel
            list={
              <div className="p-3 space-y-2">
                <div className="text-xs font-mono">row-1</div>
                <div className="text-xs font-mono">row-2</div>
                <div className="text-xs font-mono">row-3</div>
              </div>
            }
            detail={null}
            emptyState={
              <EmptyState
                title="No item selected"
                body="Pick an item from the list to see its detail."
              />
            }
          />
        </div>
      </Section>

      <Section title="ToolChip (C2 popover)">
        <div className="flex flex-wrap gap-2">
          <ToolChip
            chip={{
              toolCallId: 'demo-1',
              tool: 'read_file',
              status: 'done',
              durationMs: 142,
              args: { path: '/etc/hosts' },
              result: { content: 'localhost 127.0.0.1\n' },
            }}
          />
          <ToolChip
            chip={{
              toolCallId: 'demo-2',
              tool: 'shell',
              status: 'failed',
              failCode: 'TOOL_TIMEOUT',
              failMessage: 'Command exceeded 30s budget',
              args: { cmd: 'sleep 60' },
            }}
          />
          <ToolChip
            chip={{
              toolCallId: 'demo-3',
              tool: 'pending_call',
              status: 'pending',
            }}
          />
        </div>
        <p className="text-[10px] text-muted">
          Click a chip with args/result to open the popover; pending chips are
          inert.
        </p>
      </Section>

      <Section title="Invoice + sync badges">
        <div className="flex flex-wrap items-center gap-2">
          <InvoiceStatusBadge status="draft" />
          <InvoiceStatusBadge status="issued" />
          <InvoiceStatusBadge status="partial" />
          <InvoiceStatusBadge status="paid" />
          <InvoiceStatusBadge status="void" />
          <span className="w-2" />
          <SyncStatusBadge status="local" hasQboId={false} />
          <SyncStatusBadge status="synced" />
          <SyncStatusBadge status="drift" />
          <SyncStatusBadge status="failed" />
        </div>
      </Section>

      <Section title="Icon palette (lucide)">
        <div className="flex items-center gap-3 text-muted">
          <Calendar size={18} />
          <Mail size={18} />
          <FilePlus size={18} />
          <Trash2 size={18} />
        </div>
      </Section>
    </div>
  )
}
