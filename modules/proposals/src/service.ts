import { randomUUID } from 'node:crypto'
import type { Db } from '../../../src/storage/db.js'
import type { EventBus } from '../../../src/core/events.js'
import type { AuditActor, AuditLog } from '../../../src/modules/audit-log.js'
import type { StorageAdapter } from '../../../src/storage/adapter.js'
import type { ProjectsService } from '../../projects/src/service.js'
import { escapeBlock, escapeTableCell } from '../../../src/render/markdown-escape.js'
import { NotFoundError } from '../../../src/errors/domain.js'

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

export interface UpdateEstimateLineInput {
  id?: string                          // when present, attempt to keep the same row id
  kind?: LineKind
  description: string
  qty?: number
  unit?: string | null
  unitPrice?: number
  metadata?: Record<string, unknown>
}

export interface UpdateEstimateInput {
  estimateId: string
  status?: EstimateStatus
  notes?: string | null
  sourceScopePath?: string | null
  metadata?: Record<string, unknown>
  /** Full replacement of the line items list when provided. */
  lines?: UpdateEstimateLineInput[]
}

export interface ArtifactRow {
  kind: 'estimate' | 'proposal'
  id: string
  number: string
  projectId: string
  projectNumber: string
  projectName: string
  status: EstimateStatus | ProposalStatus
  /** "Estimate · draft", "Proposal · issued", etc. */
  displayStatus: string
  totalCents: number
  lastActivity: number
  source: 'from scope.md' | 'manual'
  scopeFilePath: string | null
}

export interface ListArtifactsOptions {
  projectId?: string
  /** A combined estimate+proposal status enum, e.g. "Estimate · draft" or "Proposal · issued". */
  status?: string[]
  limit?: number
}

export interface ProposalDetail {
  estimate: Estimate
  proposal: Proposal | null
  /** Walking previousEstimateId backwards, newest predecessor first. */
  predecessorEstimates: Estimate[]
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
  updateEstimate(input: UpdateEstimateInput, ctx: ActorContext): Estimate
  reviseEstimate(estimateId: string, ctx: ActorContext): Estimate
  createProposal(input: CreateProposalInput, ctx: ActorContext): Promise<Proposal>
  getProposal(id: string): Proposal | undefined
  listProposalsForProject(projectId: string): Proposal[]
  setProposalStatus(
    id: string,
    status: ProposalStatus,
    ctx: ActorContext,
  ): void
  supersedeProposal(
    id: string,
    supersededByProposalId: string | null,
    ctx: ActorContext,
  ): void
  /** Resolve an estimate-or-proposal id into the unified detail shape used by the
   *  Proposals panel split view. Returns undefined when the id matches nothing. */
  getProposalDetail(id: string): ProposalDetail | undefined
  /** Cross-project artifact stream: estimates without a proposal render as the
   *  estimate row; estimates with a proposal render as the proposal row. */
  listArtifacts(opts?: ListArtifactsOptions): ArtifactRow[]
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
      const desc = escapeTableCell(l.description)
      const qty = escapeTableCell(l.qty)
      const unit = escapeTableCell(l.unit ?? '')
      const unitPrice = `$${l.unitPrice.toFixed(2)}`
      const lineTotal = `$${l.lineTotal.toFixed(2)}`
      return `| ${desc} | ${qty} | ${unit} | ${unitPrice} | ${lineTotal} |`
    })
    .join('\n')
  const total = scope.estimate.lines.reduce((sum, l) => sum + l.lineTotal, 0)
  const projectNumber = escapeBlock(scope.project.number)
  const projectName = escapeBlock(scope.project.name)
  const clientLine = scope.project.client
    ? `\n**Client:** ${escapeBlock(scope.project.client)}`
    : ''
  return [
    `# Proposal ${escapeBlock(scope.proposalNumber)}`,
    '',
    `**Project:** ${projectNumber} — ${projectName}${clientLine}`,
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

  const deleteEstimateLinesStmt = deps.db.prepare(
    `DELETE FROM estimate_line WHERE estimate_id = ?`,
  )
  const updateEstimateMetaStmt = deps.db.prepare(
    `UPDATE estimate
       SET source_scope_path = ?, notes = ?, metadata_json = ?, updated_at = ?
     WHERE id = ?`,
  )
  const supersedeProposalStmt = deps.db.prepare(
    `UPDATE proposal
       SET status = 'superseded',
           previous_proposal_id = COALESCE(?, previous_proposal_id),
           updated_at = ?
     WHERE id = ?`,
  )
  const listAllProposalsStmt = deps.db.prepare(
    `SELECT * FROM proposal ORDER BY created_at DESC, rowid DESC`,
  )
  const listAllEstimatesStmt = deps.db.prepare(
    `SELECT * FROM estimate ORDER BY created_at DESC, rowid DESC`,
  )
  const findProposalByEstimateStmt = deps.db.prepare(
    `SELECT * FROM proposal WHERE estimate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )

  function loadLines(estimateId: string): EstimateLine[] {
    const rows = listLinesStmt.all(estimateId) as EstimateLineRow[]
    return rows.map(rowToLine)
  }

  const service: ProposalsService = {
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
        projectId: input.projectId,
        payload: {
          projectId: input.projectId,
          lineCount: input.lines.length,
          previousEstimateId: input.previousEstimateId ?? null,
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
      const estimate = service.getEstimate(input.estimateId)
      if (!estimate) {
        throw new NotFoundError('estimate', input.estimateId)
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
        projectId: input.projectId,
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
      if (!row) throw new NotFoundError('proposal', id)
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
        projectId: row.project_id,
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
      } else if (status === 'accepted') {
        void deps.eventBus.emit({
          type: 'proposal.accepted',
          projectId: row.project_id,
          proposalId: id,
          number: row.number,
          ts: now,
        })
      } else if (status === 'rejected') {
        void deps.eventBus.emit({
          type: 'proposal.rejected',
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
      if (!row) throw new NotFoundError('estimate', id)
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
        projectId: row.project_id,
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

    updateEstimate(input, ctx) {
      const existing = service.getEstimate(input.estimateId)
      if (!existing) throw new NotFoundError('estimate', input.estimateId)
      const now = Date.now()
      const changedFields: string[] = []

      if (
        input.sourceScopePath !== undefined ||
        input.notes !== undefined ||
        input.metadata !== undefined
      ) {
        const nextScope =
          input.sourceScopePath === undefined ? existing.sourceScopePath : input.sourceScopePath
        const nextNotes = input.notes === undefined ? existing.notes : input.notes
        const nextMeta = input.metadata === undefined ? existing.metadata : input.metadata
        updateEstimateMetaStmt.run(
          nextScope,
          nextNotes,
          JSON.stringify(nextMeta),
          now,
          input.estimateId,
        )
        if (input.sourceScopePath !== undefined) changedFields.push('sourceScopePath')
        if (input.notes !== undefined) changedFields.push('notes')
        if (input.metadata !== undefined) changedFields.push('metadata')
      }

      if (input.lines !== undefined) {
        deleteEstimateLinesStmt.run(input.estimateId)
        input.lines.forEach((line, index) => {
          const lineId = line.id ?? randomUUID()
          const kind: LineKind = line.kind ?? 'fixed'
          const qty = line.qty ?? 1
          const unitPrice = line.unitPrice ?? 0
          const lineTotal = qty * unitPrice
          insertLine.run(
            lineId,
            input.estimateId,
            kind,
            line.description,
            qty,
            line.unit ?? null,
            unitPrice,
            lineTotal,
            index,
            JSON.stringify(line.metadata ?? {}),
            now,
            now,
          )
        })
        changedFields.push('lines')
      }

      if (changedFields.length > 0) {
        deps.audit.record({
          module: 'proposals',
          action: 'estimate.updated',
          entityType: 'estimate',
          entityId: input.estimateId,
          actor: ctx.actor,
          projectId: existing.projectId,
          payload: {
            projectId: existing.projectId,
            changedFields,
          },
        })
        void deps.eventBus.emit({
          type: 'estimate.updated',
          projectId: existing.projectId,
          estimateId: input.estimateId,
          ts: now,
        })
      }

      if (input.status !== undefined && input.status !== existing.status) {
        service.setEstimateStatus(input.estimateId, input.status, ctx)
      }

      const fresh = service.getEstimate(input.estimateId)
      if (!fresh) throw new Error(`Estimate vanished mid-update: ${input.estimateId}`)
      return fresh
    },

    reviseEstimate(estimateId, ctx) {
      const old = service.getEstimate(estimateId)
      if (!old) throw new NotFoundError('estimate', estimateId)
      // The new estimate starts fresh in `draft` carrying the previous
      // lines so the operator can edit from a known baseline. The old
      // estimate's status is intentionally untouched — promote/supersede
      // is an explicit toolbar action.
      const revised = service.createEstimate(
        {
          projectId: old.projectId,
          sourceScopePath: old.sourceScopePath,
          notes: old.notes,
          previousEstimateId: old.id,
          metadata: { ...old.metadata, revisedFrom: old.id },
          lines: old.lines.map((l) => ({
            kind: l.kind,
            description: l.description,
            qty: l.qty,
            unit: l.unit,
            unitPrice: l.unitPrice,
            metadata: l.metadata,
          })),
        },
        ctx,
      )
      deps.audit.record({
        module: 'proposals',
        action: 'estimate.revised',
        entityType: 'estimate',
        entityId: revised.id,
        actor: ctx.actor,
        projectId: old.projectId,
        payload: {
          projectId: old.projectId,
          previousEstimateId: old.id,
        },
      })
      return revised
    },

    supersedeProposal(id, supersededByProposalId, ctx) {
      const row = getProposalProjectStmt.get(id) as
        | { project_id: string; number: string }
        | undefined
      if (!row) throw new NotFoundError('proposal', id)
      const now = Date.now()
      supersedeProposalStmt.run(supersededByProposalId, now, id)
      deps.audit.record({
        module: 'proposals',
        action: 'proposal.superseded',
        entityType: 'proposal',
        entityId: id,
        actor: ctx.actor,
        projectId: row.project_id,
        payload: {
          projectId: row.project_id,
          number: row.number,
          supersededByProposalId,
        },
      })
      void deps.eventBus.emit({
        type: 'proposal.superseded',
        projectId: row.project_id,
        proposalId: id,
        ts: now,
      })
    },

    getProposalDetail(id) {
      // First try treating the id as a proposal id; fall back to estimate id.
      const proposalRow = getProposalStmt.get(id) as ProposalRow | undefined
      if (proposalRow) {
        const proposal = rowToProposal(proposalRow)
        const estimate = service.getEstimate(proposal.estimateId)
        if (!estimate) return undefined
        return {
          estimate,
          proposal,
          predecessorEstimates: walkPredecessors(estimate, service),
        }
      }
      const estimate = service.getEstimate(id)
      if (!estimate) return undefined
      const linked = findProposalByEstimateStmt.get(estimate.id) as ProposalRow | undefined
      return {
        estimate,
        proposal: linked ? rowToProposal(linked) : null,
        predecessorEstimates: walkPredecessors(estimate, service),
      }
    },

    listArtifacts(opts) {
      const projectFilter = opts?.projectId
      const statusFilter = opts?.status
      const limit = opts?.limit ?? 500

      // Pull both tables and merge — at v2 scale (single user, hundreds of
      // estimates) the cost is negligible; doing this in SQL would need a
      // complicated UNION ALL with status case-statement. Keep it in JS.
      const allEstimates = (
        projectFilter
          ? (listEstimatesByProjectStmt.all(projectFilter) as EstimateRow[])
          : (listAllEstimatesStmt.all() as EstimateRow[])
      ).map((r) => rowToEstimate(r, loadLines(r.id)))
      const allProposals = (
        projectFilter
          ? (listProposalsByProjectStmt.all(projectFilter) as ProposalRow[])
          : (listAllProposalsStmt.all() as ProposalRow[])
      ).map(rowToProposal)
      const proposalByEstimate = new Map<string, Proposal>()
      for (const p of allProposals) {
        // Newest proposal for the estimate wins when multiple exist (rare —
        // would only happen across revisions, but we still want stable rows).
        const prior = proposalByEstimate.get(p.estimateId)
        if (!prior || p.createdAt > prior.createdAt) {
          proposalByEstimate.set(p.estimateId, p)
        }
      }
      const projectMeta = (projectId: string): { number: string; name: string } => {
        if (deps.projects) {
          const p = deps.projects.getProject(projectId)
          if (p) return { number: p.number, name: p.name }
        }
        return { number: projectId, name: projectId }
      }

      const rows: ArtifactRow[] = []
      for (const e of allEstimates) {
        const proposal = proposalByEstimate.get(e.id)
        const total = e.lines.reduce(
          (sum, l) => sum + Math.round(l.qty * l.unitPrice * 100),
          0,
        )
        const meta = projectMeta(e.projectId)
        if (proposal) {
          rows.push({
            kind: 'proposal',
            id: proposal.id,
            number: proposal.number,
            projectId: e.projectId,
            projectNumber: meta.number,
            projectName: meta.name,
            status: proposal.status,
            displayStatus: formatProposalStatus(proposal.status),
            totalCents: total,
            lastActivity: Math.max(proposal.updatedAt, e.updatedAt),
            source: e.sourceScopePath ? 'from scope.md' : 'manual',
            scopeFilePath: e.sourceScopePath,
          })
        } else {
          rows.push({
            kind: 'estimate',
            id: e.id,
            number: shortEstimateNumber(e),
            projectId: e.projectId,
            projectNumber: meta.number,
            projectName: meta.name,
            status: e.status,
            displayStatus: formatEstimateStatus(e.status),
            totalCents: total,
            lastActivity: e.updatedAt,
            source: e.sourceScopePath ? 'from scope.md' : 'manual',
            scopeFilePath: e.sourceScopePath,
          })
        }
      }
      rows.sort((a, b) => b.lastActivity - a.lastActivity)

      const filtered = statusFilter && statusFilter.length > 0
        ? rows.filter((r) => statusFilter.includes(r.displayStatus))
        : rows
      return filtered.slice(0, limit)
    },
  }
  return service
}

function walkPredecessors(
  estimate: Estimate,
  service: ProposalsService,
): Estimate[] {
  const out: Estimate[] = []
  let current: Estimate | undefined = estimate
  const seen = new Set<string>()
  while (current?.previousEstimateId) {
    if (seen.has(current.previousEstimateId)) break
    seen.add(current.previousEstimateId)
    const prev = service.getEstimate(current.previousEstimateId)
    if (!prev) break
    out.push(prev)
    current = prev
  }
  return out
}

function formatEstimateStatus(s: EstimateStatus): string {
  return `Estimate · ${s}`
}

function formatProposalStatus(s: ProposalStatus): string {
  return `Proposal · ${s}`
}

function shortEstimateNumber(e: Estimate): string {
  // For estimate-only rows we don't have a human number — show the first 8
  // chars of the id so the table has *something* to render and the row stays
  // navigable.
  return `E-${e.id.slice(0, 8)}`
}
