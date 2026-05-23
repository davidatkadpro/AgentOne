import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { StorageAdapter } from '../../../src/storage/adapter.js'
import type { ProjectsService } from '../../projects/src/service.js'

export type EstimateStatus =
  | 'draft'
  | 'ready'
  | 'accepted'
  | 'rejected'
  | 'superseded'

export type LineKind = 'fixed' | 'time_and_materials' | 'unit'

export interface EstimateLine {
  id: string
  estimateId: string
  kind: LineKind
  description: string
  qty: number
  unit: string | null
  unitPrice: number
  lineTotal: number
  position: number
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface Estimate {
  id: string
  projectId: string
  version: number
  sourceScopePath: string | null
  status: EstimateStatus
  notes: string | null
  previousEstimateId: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  decidedAt: number | null
  lines: EstimateLine[]
}

export interface CreateEstimateLineInput {
  kind?: LineKind
  description: string
  qty?: number
  unit?: string | null
  unitPrice?: number
  metadata?: Record<string, unknown>
}

export interface CreateEstimateInput {
  projectId: string
  sourceScopePath?: string | null
  notes?: string | null
  previousEstimateId?: string | null
  metadata?: Record<string, unknown>
  lines: CreateEstimateLineInput[]
}

export interface ActorContext {
  actor: AuditActor
}

export type ProposalStatus =
  | 'draft'
  | 'issued'
  | 'accepted'
  | 'rejected'
  | 'superseded'

export interface Proposal {
  id: string
  projectId: string
  estimateId: string
  number: string
  status: ProposalStatus
  templateName: string
  renderedMarkdownPath: string | null
  previousProposalId: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  issuedAt: number | null
  decidedAt: number | null
}

export interface CreateProposalInput {
  projectId: string
  estimateId: string
  templateName?: string
  metadata?: Record<string, unknown>
}

export interface ProposalsService {
  createEstimate(input: CreateEstimateInput, ctx: ActorContext): Estimate
  getEstimate(id: string): Estimate | undefined
  listEstimatesForProject(projectId: string): Estimate[]
  setEstimateStatus(
    id: string,
    status: EstimateStatus,
    ctx: ActorContext,
  ): void
  createProposal(input: CreateProposalInput, ctx: ActorContext): Promise<Proposal>
  getProposal(id: string): Proposal | undefined
  listProposalsForProject(projectId: string): Proposal[]
  setProposalStatus(
    id: string,
    status: ProposalStatus,
    ctx: ActorContext,
  ): void
}

export interface ProposalsServiceDeps {
  db: Db
  eventBus: EventBus
  audit: AuditLog
  /** Required for createProposal — looks up the project's folder_path so the
   *  rendered markdown lands under `<project.folderPath>/drafts/proposals/`. */
  projects?: ProjectsService
  /** Required for createProposal — writes the rendered markdown file. */
  storage?: StorageAdapter
}

interface ProposalRow {
  id: string
  project_id: string
  estimate_id: string
  number: string
  status: string
  template_name: string
  rendered_markdown_path: string | null
  previous_proposal_id: string | null
  metadata_json: string
  created_at: number
  updated_at: number
  issued_at: number | null
  decided_at: number | null
}

interface EstimateRow {
  id: string
  project_id: string
  version: number
  source_scope_path: string | null
  status: string
  notes: string | null
  previous_estimate_id: string | null
  metadata_json: string
  created_at: number
  updated_at: number
  decided_at: number | null
}

interface EstimateLineRow {
  id: string
  estimate_id: string
  kind: string
  description: string
  qty: number
  unit: string | null
  unit_price: number
  line_total: number
  position: number
  metadata_json: string
  created_at: number
  updated_at: number
}

const VALID_STATUSES: ReadonlySet<EstimateStatus> = new Set([
  'draft',
  'ready',
  'accepted',
  'rejected',
  'superseded',
])

const VALID_KINDS: ReadonlySet<LineKind> = new Set(['fixed', 'time_and_materials', 'unit'])

const VALID_PROPOSAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  'draft',
  'issued',
  'accepted',
  'rejected',
  'superseded',
])

function parseProposalStatus(raw: string): ProposalStatus {
  if (VALID_PROPOSAL_STATUSES.has(raw as ProposalStatus)) return raw as ProposalStatus
  throw new Error(`Invalid proposal status in store: ${raw}`)
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    projectId: row.project_id,
    estimateId: row.estimate_id,
    number: row.number,
    status: parseProposalStatus(row.status),
    templateName: row.template_name,
    renderedMarkdownPath: row.rendered_markdown_path,
    previousProposalId: row.previous_proposal_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issuedAt: row.issued_at,
    decidedAt: row.decided_at,
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Render the v0.1 inline template. Future versions will load from
 * `modules/proposals/templates/<templateName>/template.md` and consult
 * `drafts/_templates/proposals/<name>/` for operator overrides. The output
 * is intentionally readable as plain markdown — no styling, no images.
 */
function renderProposalMarkdown(scope: {
  proposalNumber: string
  project: { number: string; name: string; client: string | null }
  estimate: Estimate
}): string {
  const lineRows = scope.estimate.lines
    .map((l) => {
      const unit = l.unit ?? ''
      return `| ${l.description} | ${l.qty} | ${unit} | $${l.unitPrice.toFixed(2)} | $${l.lineTotal.toFixed(2)} |`
    })
    .join('\n')
  const total = scope.estimate.lines.reduce((sum, l) => sum + l.lineTotal, 0)
  const clientLine = scope.project.client
    ? `\n**Client:** ${scope.project.client}`
    : ''
  return [
    `# Proposal ${scope.proposalNumber}`,
    '',
    `**Project:** ${scope.project.number} — ${scope.project.name}${clientLine}`,
    '',
    '## Line items',
    '',
    '| Description | Qty | Unit | Unit price | Line total |',
    '|-------------|-----|------|------------|------------|',
    lineRows.length > 0 ? lineRows : '| _no line items_ | | | | |',
    '',
    `**Total: $${total.toFixed(2)}**`,
    '',
    '---',
    '',
    `*Draft proposal generated ${todayIso()}. Estimate id: ${scope.estimate.id}*`,
    '',
  ].join('\n')
}

function parseStatus(raw: string): EstimateStatus {
  if (VALID_STATUSES.has(raw as EstimateStatus)) return raw as EstimateStatus
  throw new Error(`Invalid estimate status in store: ${raw}`)
}

function parseKind(raw: string): LineKind {
  if (VALID_KINDS.has(raw as LineKind)) return raw as LineKind
  throw new Error(`Invalid estimate_line kind in store: ${raw}`)
}

function rowToLine(row: EstimateLineRow): EstimateLine {
  return {
    id: row.id,
    estimateId: row.estimate_id,
    kind: parseKind(row.kind),
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    unitPrice: row.unit_price,
    lineTotal: row.line_total,
    position: row.position,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEstimate(row: EstimateRow, lines: EstimateLine[]): Estimate {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    sourceScopePath: row.source_scope_path,
    status: parseStatus(row.status),
    notes: row.notes,
    previousEstimateId: row.previous_estimate_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    lines,
  }
}

export function createProposalsService(deps: ProposalsServiceDeps): ProposalsService {
  const insertEstimate = deps.db.prepare(
    `INSERT INTO estimate
       (id, project_id, version, source_scope_path, notes, previous_estimate_id,
        metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertLine = deps.db.prepare(
    `INSERT INTO estimate_line
       (id, estimate_id, kind, description, qty, unit, unit_price, line_total,
        position, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getEstimateStmt = deps.db.prepare('SELECT * FROM estimate WHERE id = ?')
  const listLinesStmt = deps.db.prepare(
    'SELECT * FROM estimate_line WHERE estimate_id = ? ORDER BY position ASC, rowid ASC',
  )
  const listEstimatesByProjectStmt = deps.db.prepare(
    'SELECT * FROM estimate WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const updateEstimateStatusStmt = deps.db.prepare(
    `UPDATE estimate
       SET status = ?, updated_at = ?,
           decided_at = CASE
             WHEN ? IN ('accepted', 'rejected') THEN ?
             ELSE decided_at
           END
     WHERE id = ?`,
  )
  const getEstimateProjectStmt = deps.db.prepare(
    'SELECT project_id FROM estimate WHERE id = ?',
  )
  const insertProposal = deps.db.prepare(
    `INSERT INTO proposal
       (id, project_id, estimate_id, number, template_name, rendered_markdown_path,
        previous_proposal_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const getProposalStmt = deps.db.prepare('SELECT * FROM proposal WHERE id = ?')
  const listProposalsByProjectStmt = deps.db.prepare(
    'SELECT * FROM proposal WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
  )
  const maxProposalSeqStmt = deps.db.prepare(
    `SELECT number FROM proposal WHERE project_id = ?`,
  )
  const updateProposalStatusStmt = deps.db.prepare(
    `UPDATE proposal
       SET status = ?, updated_at = ?,
           issued_at = CASE WHEN ? = 'issued' THEN ? ELSE issued_at END,
           decided_at = CASE
             WHEN ? IN ('accepted', 'rejected') THEN ?
             ELSE decided_at
           END
     WHERE id = ?`,
  )
  const getProposalProjectStmt = deps.db.prepare(
    'SELECT project_id, number FROM proposal WHERE id = ?',
  )

  function loadLines(estimateId: string): EstimateLine[] {
    const rows = listLinesStmt.all(estimateId) as EstimateLineRow[]
    return rows.map(rowToLine)
  }

  return {
    createEstimate(input, ctx) {
      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}
      // INSERT estimate first — FK on project_id will reject unknown projects.
      insertEstimate.run(
        id,
        input.projectId,
        1,
        input.sourceScopePath ?? null,
        input.notes ?? null,
        input.previousEstimateId ?? null,
        JSON.stringify(metadata),
        now,
        now,
      )

      const lines: EstimateLine[] = []
      input.lines.forEach((lineInput, index) => {
        const lineId = randomUUID()
        const kind: LineKind = lineInput.kind ?? 'fixed'
        const qty = lineInput.qty ?? 1
        const unitPrice = lineInput.unitPrice ?? 0
        const lineTotal = qty * unitPrice
        const lineMeta = lineInput.metadata ?? {}
        insertLine.run(
          lineId,
          id,
          kind,
          lineInput.description,
          qty,
          lineInput.unit ?? null,
          unitPrice,
          lineTotal,
          index,
          JSON.stringify(lineMeta),
          now,
          now,
        )
        lines.push({
          id: lineId,
          estimateId: id,
          kind,
          description: lineInput.description,
          qty,
          unit: lineInput.unit ?? null,
          unitPrice,
          lineTotal,
          position: index,
          metadata: lineMeta,
          createdAt: now,
          updatedAt: now,
        })
      })

      deps.audit.record({
        module: 'proposals',
        action: 'estimate.created',
        entityType: 'estimate',
        entityId: id,
        actor: ctx.actor,
        payload: {
          projectId: input.projectId,
          lineCount: input.lines.length,
        },
      })

      void deps.eventBus.emit({
        type: 'estimate.created',
        projectId: input.projectId,
        estimateId: id,
        ts: now,
      })

      return {
        id,
        projectId: input.projectId,
        version: 1,
        sourceScopePath: input.sourceScopePath ?? null,
        status: 'draft',
        notes: input.notes ?? null,
        previousEstimateId: input.previousEstimateId ?? null,
        metadata,
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
        lines,
      }
    },

    getEstimate(id) {
      const row = getEstimateStmt.get(id) as EstimateRow | undefined
      if (!row) return undefined
      return rowToEstimate(row, loadLines(id))
    },

    listEstimatesForProject(projectId) {
      const rows = listEstimatesByProjectStmt.all(projectId) as EstimateRow[]
      return rows.map((r) => rowToEstimate(r, loadLines(r.id)))
    },

    async createProposal(input, ctx) {
      if (!deps.projects || !deps.storage) {
        throw new Error(
          'ProposalsService.createProposal requires `projects` and `storage` deps',
        )
      }
      const estimate = this.getEstimate(input.estimateId)
      if (!estimate) {
        throw new Error(`Estimate not found: ${input.estimateId}`)
      }
      if (estimate.projectId !== input.projectId) {
        throw new Error(
          `Estimate ${input.estimateId} belongs to project ${estimate.projectId}, not ${input.projectId}`,
        )
      }
      const project = deps.projects.getProject(input.projectId)
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      if (!project.folderPath) {
        throw new Error(`Project ${input.projectId} has no folder_path`)
      }

      // Next sequence for this project — look at existing proposal numbers
      // matching `<project.number>-P<NN>` and pick max+1.
      const existing = maxProposalSeqStmt.all(input.projectId) as { number: string }[]
      const prefix = `${project.number}-P`
      let maxSeq = 0
      for (const e of existing) {
        if (e.number.startsWith(prefix)) {
          const n = Number.parseInt(e.number.slice(prefix.length), 10)
          if (Number.isFinite(n) && n > maxSeq) maxSeq = n
        }
      }
      const proposalNumber = `${prefix}${maxSeq + 1}`

      const templateName = input.templateName ?? 'default'
      const id = randomUUID()
      const now = Date.now()
      const metadata = input.metadata ?? {}

      const markdown = renderProposalMarkdown({
        proposalNumber,
        project: { number: project.number, name: project.name, client: project.client },
        estimate,
      })
      const fileName = `${proposalNumber}.md`
      const renderedPath = `${project.folderPath}/drafts/proposals/${fileName}`
      // write() mkdirs the parent — no separate ensureDir needed.
      await deps.storage.write(renderedPath, markdown)

      insertProposal.run(
        id,
        input.projectId,
        input.estimateId,
        proposalNumber,
        templateName,
        renderedPath,
        null,
        JSON.stringify(metadata),
        now,
        now,
      )

      deps.audit.record({
        module: 'proposals',
        action: 'proposal.created',
        entityType: 'proposal',
        entityId: id,
        actor: ctx.actor,
        payload: {
          projectId: input.projectId,
          estimateId: input.estimateId,
          number: proposalNumber,
        },
      })

      void deps.eventBus.emit({
        type: 'proposal.created',
        projectId: input.projectId,
        proposalId: id,
        number: proposalNumber,
        ts: now,
      })

      return {
        id,
        projectId: input.projectId,
        estimateId: input.estimateId,
        number: proposalNumber,
        status: 'draft',
        templateName,
        renderedMarkdownPath: renderedPath,
        previousProposalId: null,
        metadata,
        createdAt: now,
        updatedAt: now,
        issuedAt: null,
        decidedAt: null,
      }
    },

    getProposal(id) {
      const row = getProposalStmt.get(id) as ProposalRow | undefined
      return row ? rowToProposal(row) : undefined
    },

    listProposalsForProject(projectId) {
      const rows = listProposalsByProjectStmt.all(projectId) as ProposalRow[]
      return rows.map(rowToProposal)
    },

    setProposalStatus(id, status, ctx) {
      const row = getProposalProjectStmt.get(id) as
        | { project_id: string; number: string }
        | undefined
      if (!row) throw new Error(`Proposal not found: ${id}`)
      const now = Date.now()
      updateProposalStatusStmt.run(status, now, status, now, status, now, id)
      deps.audit.record({
        module: 'proposals',
        action:
          status === 'issued'
            ? 'proposal.issued'
            : status === 'superseded'
              ? 'proposal.superseded'
              : 'proposal.updated',
        entityType: 'proposal',
        entityId: id,
        actor: ctx.actor,
        payload: { status, projectId: row.project_id, number: row.number },
      })
      if (status === 'issued') {
        void deps.eventBus.emit({
          type: 'proposal.issued',
          projectId: row.project_id,
          proposalId: id,
          number: row.number,
          ts: now,
        })
      } else if (status === 'superseded') {
        void deps.eventBus.emit({
          type: 'proposal.superseded',
          projectId: row.project_id,
          proposalId: id,
          ts: now,
        })
      }
    },

    setEstimateStatus(id, status, ctx) {
      const row = getEstimateProjectStmt.get(id) as { project_id: string } | undefined
      if (!row) throw new Error(`Estimate not found: ${id}`)
      const now = Date.now()
      updateEstimateStatusStmt.run(status, now, status, now, id)
      deps.audit.record({
        module: 'proposals',
        action:
          status === 'accepted'
            ? 'estimate.accepted'
            : status === 'rejected'
              ? 'estimate.rejected'
              : 'estimate.updated',
        entityType: 'estimate',
        entityId: id,
        actor: ctx.actor,
        payload: { status, projectId: row.project_id },
      })
      const event =
        status === 'accepted'
          ? { type: 'estimate.accepted' as const, projectId: row.project_id, estimateId: id, ts: now }
          : status === 'rejected'
            ? { type: 'estimate.rejected' as const, projectId: row.project_id, estimateId: id, ts: now }
            : { type: 'estimate.updated' as const, projectId: row.project_id, estimateId: id, ts: now }
      void deps.eventBus.emit(event)
    },
  }
}
