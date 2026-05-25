import { z } from 'zod'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { confineToRoot } from '../../../src/storage/path-confine.js'
import { renderPandoc } from '../../../src/render/pandoc.js'
import { moneyNonNegative, qtyNonNegative } from '../../../src/modules/numeric.js'
import { mapDomainError } from '../../../src/errors/domain.js'
import type { FastifyInstance } from 'fastify'
import type { AuditLog } from '../../../src/modules/audit-log.js'
import type { EventBus } from '../../../src/core/events.js'
import {
  type ActorContext,
  type EstimateStatus,
  type LineKind,
  type ProposalsService,
  type ProposalStatus,
} from './service.js'

const LineKindEnum: z.ZodType<LineKind> = z.enum(['fixed', 'time_and_materials', 'unit'])
const EstimateStatusEnum: z.ZodType<EstimateStatus> = z.enum([
  'draft',
  'ready',
  'accepted',
  'rejected',
  'superseded',
])
const ProposalStatusEnum: z.ZodType<ProposalStatus> = z.enum([
  'draft',
  'issued',
  'accepted',
  'rejected',
  'superseded',
])

const CreateEstimateBody = z.object({
  sourceScopePath: z.string().optional(),
  scopeFilePath: z.string().optional(),       // accept either name
  notes: z.string().optional(),
  templateName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  lines: z
    .array(
      z.object({
        kind: LineKindEnum.optional(),
        description: z.string().min(1),
        qty: qtyNonNegative().optional(),
        unit: z.string().optional(),
        unitPrice: moneyNonNegative().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .optional(),
})

const UpdateEstimateBody = z
  .object({
    status: EstimateStatusEnum.optional(),
    notes: z.string().nullable().optional(),
    sourceScopePath: z.string().nullable().optional(),
    scopeFilePath: z.string().nullable().optional(),
    templateName: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    lines: z
      .array(
        z.object({
          id: z.string().optional(),
          kind: LineKindEnum.optional(),
          description: z.string().min(1),
          qty: qtyNonNegative().optional(),
          unit: z.string().nullable().optional(),
          unitPrice: moneyNonNegative().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Empty body' })

const CreateProposalBody = z.object({
  estimateId: z.string().min(1),
  templateName: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const ProjectIdParams = z.object({ projectId: z.string().min(1) })
const EstimateIdParams = z.object({ id: z.string().min(1) })
const ProposalIdParams = z.object({ id: z.string().min(1) })
const DownloadParams = z.object({
  id: z.string().min(1),
  format: z.enum(['md', 'pdf', 'docx']),
})

const PatchEstimateStatusBody = z.object({ status: EstimateStatusEnum })
const UpdateProposalBody = z
  .object({
    status: ProposalStatusEnum.optional(),
    supersededByProposalId: z.string().nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.supersededByProposalId !== undefined, {
    message: 'Empty body',
  })

const RenderBody = z.object({
  formats: z.array(z.enum(['md', 'pdf', 'docx'])).min(1),
})

const ArtifactsQuery = z.object({
  projectId: z.string().optional(),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const HistoryQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
})

const HTTP_ACTOR: ActorContext = { actor: { type: 'user' } }

export interface RegisterProposalsRoutesDeps {
  service: ProposalsService
  /** Required for /history routes; tests can omit when not exercised. */
  audit?: AuditLog
  /** Absolute path to the storage root. Required for render+download +
   *  scope-file walking; tests can omit when not exercised. */
  storageRoot?: string
  /** Absolute path to the modules root (contains `proposals/templates/`).
   *  When omitted, `bundled` templates aren't surfaced. */
  modulesRoot?: string
  /** Whether Pandoc is on PATH. Drives PDF/docx availability. Default false. */
  pandocAvailable?: boolean
  /** Optional. When present, mtime changes under the templates folder fire
   *  `module.reloaded` so React invalidates the templates cache. */
  eventBus?: EventBus
}

export async function registerProposalsRoutes(
  app: FastifyInstance,
  deps: RegisterProposalsRoutesDeps,
): Promise<void> {
  const { service, audit, storageRoot, modulesRoot } = deps
  const pandocAvailable = deps.pandocAvailable ?? false

  // P4P1: ADR-0007 alias pattern. Same handler at both `/api/v1/<...>` and
  // `/api/<...>`. The v1 prefix stays for legacy callers and existing tests.

  function bothPaths(suffix: string): string[] {
    return [`/api/v1${suffix}`, `/api${suffix}`]
  }

  // ── Estimates ──────────────────────────────────────────────────────────

  for (const url of bothPaths('/projects/:projectId/estimates')) {
    app.post(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = CreateEstimateBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const createInput: Parameters<typeof service.createEstimate>[0] = {
          projectId: params.data.projectId,
          lines: body.data.lines ?? [],
        }
        const scope = body.data.sourceScopePath ?? body.data.scopeFilePath
        if (scope !== undefined) createInput.sourceScopePath = scope
        if (body.data.notes !== undefined) createInput.notes = body.data.notes
        if (body.data.metadata !== undefined) createInput.metadata = body.data.metadata
        if (body.data.templateName !== undefined) {
          createInput.metadata = {
            ...(createInput.metadata ?? {}),
            templateName: body.data.templateName,
          }
        }
        const estimate = service.createEstimate(createInput, HTTP_ACTOR)
        reply.code(201)
        return { estimate }
      } catch (err) {
        reply.code(400)
        return {
          error: 'CREATE_ESTIMATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  for (const url of bothPaths('/projects/:projectId/estimates')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      return { estimates: service.listEstimatesForProject(params.data.projectId) }
    })
  }

  for (const url of bothPaths('/estimates/:id')) {
    app.get(url, async (req, reply) => {
      const params = EstimateIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const estimate = service.getEstimate(params.data.id)
      if (!estimate) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return { estimate }
    })
  }

  for (const url of bothPaths('/estimates/:id/status')) {
    app.patch(url, async (req, reply) => {
      const params = EstimateIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = PatchEstimateStatusBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        service.setEstimateStatus(params.data.id, body.data.status, HTTP_ACTOR)
      } catch (err) {
        const mapped = mapDomainError(err)
        if (mapped) {
          reply.code(mapped.status)
          return mapped.body
        }
        throw err
      }
      return { estimate: service.getEstimate(params.data.id) }
    })
  }

  // P4: full PATCH /api/estimates/:id (lines, notes, metadata, etc.)
  for (const url of bothPaths('/estimates/:id')) {
    app.patch(url, async (req, reply) => {
      const params = EstimateIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdateEstimateBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (!service.getEstimate(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      try {
        const update: Parameters<typeof service.updateEstimate>[0] = {
          estimateId: params.data.id,
        }
        if (body.data.status !== undefined) update.status = body.data.status
        if (body.data.notes !== undefined) update.notes = body.data.notes
        if (body.data.sourceScopePath !== undefined)
          update.sourceScopePath = body.data.sourceScopePath
        else if (body.data.scopeFilePath !== undefined)
          update.sourceScopePath = body.data.scopeFilePath
        if (body.data.metadata !== undefined || body.data.templateName !== undefined) {
          // merge templateName into metadata for forwards compatibility
          const merged = { ...(body.data.metadata ?? {}) }
          if (body.data.templateName !== undefined) {
            merged.templateName = body.data.templateName
          }
          update.metadata = merged
        }
        if (body.data.lines !== undefined) {
          update.lines = body.data.lines.map((l) => {
            const out: NonNullable<typeof update.lines>[number] = {
              description: l.description,
            }
            if (l.id !== undefined) out.id = l.id
            if (l.kind !== undefined) out.kind = l.kind
            if (l.qty !== undefined) out.qty = l.qty
            if (l.unit !== undefined) out.unit = l.unit
            if (l.unitPrice !== undefined) out.unitPrice = l.unitPrice
            if (l.metadata !== undefined) out.metadata = l.metadata
            return out
          })
        }
        const estimate = service.updateEstimate(update, HTTP_ACTOR)
        return { estimate }
      } catch (err) {
        reply.code(400)
        return {
          error: 'UPDATE_ESTIMATE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  // P4P4: POST /api/estimates/:id/revise
  for (const url of bothPaths('/estimates/:id/revise')) {
    app.post(url, async (req, reply) => {
      const params = EstimateIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      if (!service.getEstimate(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      try {
        const estimate = service.reviseEstimate(params.data.id, HTTP_ACTOR)
        reply.code(201)
        return { estimate }
      } catch (err) {
        reply.code(400)
        return {
          error: 'REVISE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  // ── Proposals ──────────────────────────────────────────────────────────

  for (const url of bothPaths('/projects/:projectId/proposals')) {
    app.post(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = CreateProposalBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        const createInput: Parameters<typeof service.createProposal>[0] = {
          projectId: params.data.projectId,
          estimateId: body.data.estimateId,
        }
        if (body.data.templateName !== undefined) createInput.templateName = body.data.templateName
        if (body.data.metadata !== undefined) createInput.metadata = body.data.metadata
        const proposal = await service.createProposal(createInput, HTTP_ACTOR)
        reply.code(201)
        return { proposal }
      } catch (err) {
        reply.code(400)
        return {
          error: 'CREATE_PROPOSAL_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    })
  }

  for (const url of bothPaths('/projects/:projectId/proposals')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      return { proposals: service.listProposalsForProject(params.data.projectId) }
    })
  }

  // P4P2: cross-project rolling stream of estimates+proposals.
  // Mounted BEFORE `/proposals/:id` so the literal segment wins.
  for (const url of bothPaths('/proposals/artifacts')) {
    app.get(url, async (req, reply) => {
      const parsed = ArtifactsQuery.safeParse(req.query ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { error: 'INVALID_QUERY', details: parsed.error.flatten() }
      }
      const status =
        parsed.data.status === undefined
          ? undefined
          : Array.isArray(parsed.data.status)
            ? parsed.data.status
            : [parsed.data.status]
      const opts: Parameters<typeof service.listArtifacts>[0] = {}
      if (parsed.data.projectId !== undefined) opts.projectId = parsed.data.projectId
      if (status !== undefined) opts.status = status
      if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit
      let rows = service.listArtifacts(opts)
      if (parsed.data.search && parsed.data.search.trim()) {
        const q = parsed.data.search.trim().toLowerCase()
        rows = rows.filter(
          (r) =>
            r.number.toLowerCase().includes(q) ||
            r.projectNumber.toLowerCase().includes(q) ||
            r.projectName.toLowerCase().includes(q),
        )
      }
      return { artifacts: rows }
    })
  }

  // P4P6: list templates from both the bundled module folder and the
  // operator's overrides at `drafts/_templates/proposals/`. Override wins
  // on name collision.
  //
  // P4P9: cache by combined mtime of both folders. On a cache miss after the
  // first warm fetch, emit `module.reloaded` so the React templates query
  // refetches without a restart. Same idea as `registerModuleActionsDiscovery`.
  let templatesCache: {
    mtimeSig: string
    body: {
      templates: Array<{
        name: string
        source: 'module' | 'override'
        path: string
        description: string | null
      }>
    }
  } | null = null
  async function templatesMtimeSig(): Promise<string> {
    const parts: string[] = []
    if (modulesRoot) {
      try {
        const s = await stat(join(modulesRoot, 'proposals', 'templates'))
        parts.push(`m:${s.mtimeMs}`)
      } catch {
        parts.push('m:none')
      }
    }
    if (storageRoot) {
      try {
        const s = await stat(join(storageRoot, 'drafts', '_templates', 'proposals'))
        parts.push(`o:${s.mtimeMs}`)
      } catch {
        parts.push('o:none')
      }
    }
    return parts.join('|')
  }
  for (const url of bothPaths('/proposals/templates')) {
    app.get(url, async () => {
      const sig = await templatesMtimeSig()
      if (templatesCache && templatesCache.mtimeSig === sig) {
        return templatesCache.body
      }
      const isReload = templatesCache !== null
      type Entry = {
        name: string
        source: 'module' | 'override'
        path: string
        description: string | null
      }
      const out = new Map<string, Entry>()
      // Bundled
      if (modulesRoot) {
        const bundledDir = join(modulesRoot, 'proposals', 'templates')
        try {
          const ents = await readdir(bundledDir, { withFileTypes: true })
          for (const e of ents) {
            if (!e.isDirectory()) continue
            const p = join(bundledDir, e.name)
            out.set(e.name, {
              name: e.name,
              source: 'module',
              path: p,
              description: await readTemplateDescription(p),
            })
          }
        } catch {
          // No bundled templates folder yet — fine; ship empty.
        }
      }
      // Overrides
      if (storageRoot) {
        const overrideDir = join(storageRoot, 'drafts', '_templates', 'proposals')
        try {
          const ents = await readdir(overrideDir, { withFileTypes: true })
          for (const e of ents) {
            if (!e.isDirectory()) continue
            const p = join(overrideDir, e.name)
            out.set(e.name, {
              name: e.name,
              source: 'override',
              path: p,
              description: await readTemplateDescription(p),
            })
          }
        } catch {
          // No override folder — that's the common case.
        }
      }
      const body = {
        templates: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }
      templatesCache = { mtimeSig: sig, body }
      if (isReload && deps.eventBus) {
        void deps.eventBus.emit({
          type: 'module.reloaded',
          module: 'proposals',
          ts: Date.now(),
        })
      }
      return body
    })
  }

  // P4P7: list every scope.md for a project.
  for (const url of bothPaths('/projects/:projectId/scope-files')) {
    app.get(url, async (req, reply) => {
      const params = ProjectIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      if (!storageRoot) {
        return { files: [] }
      }
      // Resolve project folder via the service so we don't take a circular
      // dep on the projects module here.
      // The project's `folderPath` is stored on the row. We do a small
      // walk under it.
      // But here we don't have direct access. Fall back to scanning the
      // conventional structure: projects/<number>-<slug>/in/<*>/scope.md.
      const candidates: Array<{ path: string; mtime: string; bytes: number }> = []
      const projectsRoot = join(storageRoot, 'projects')
      let projectDirs
      try {
        projectDirs = await readdir(projectsRoot, { withFileTypes: true })
      } catch {
        return { files: [] }
      }
      for (const pd of projectDirs) {
        if (!pd.isDirectory()) continue
        // We accept either `<number>-<slug>` or any folder where a
        // marker file lives — simplest match is "folder name starts with the
        // project's number". We don't have project.number here without the
        // projects service; we'd have to wire that. For now, since this
        // route's caller is the "New proposal" dialog which already
        // disambiguates per-project, we walk all candidates and the dialog
        // filters by visual project pick.
        const inDir = join(projectsRoot, pd.name, 'in')
        let subs
        try {
          subs = await readdir(inDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const sub of subs) {
          if (!sub.isDirectory()) continue
          const scope = join(inDir, sub.name, 'scope.md')
          try {
            const s = await stat(scope)
            if (s.isFile()) {
              candidates.push({
                path: `projects/${pd.name}/in/${sub.name}/scope.md`,
                mtime: new Date(s.mtimeMs).toISOString(),
                bytes: s.size,
              })
            }
          } catch {
            // not a scope folder
          }
        }
      }
      candidates.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
      return { files: candidates }
    })
  }

  // P4P3: unified detail endpoint. Accepts either an estimate id or a
  // proposal id and returns both when the proposal exists, plus the chain
  // of predecessor estimates.
  for (const url of bothPaths('/proposals/:id')) {
    app.get(url, async (req, reply) => {
      const params = ProposalIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const detail = service.getProposalDetail(params.data.id)
      if (!detail) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return detail
    })
  }

  // Legacy path (kept to not break tests) for status-only patch.
  for (const url of bothPaths('/proposals/:id/status')) {
    app.patch(url, async (req, reply) => {
      const params = ProposalIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = z.object({ status: ProposalStatusEnum }).safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      try {
        service.setProposalStatus(params.data.id, body.data.status, HTTP_ACTOR)
      } catch {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      return { proposal: service.getProposal(params.data.id) }
    })
  }

  // P4: PATCH /api/proposals/:id (status + supersede combined)
  for (const url of bothPaths('/proposals/:id')) {
    app.patch(url, async (req, reply) => {
      const params = ProposalIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = UpdateProposalBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      if (!service.getProposal(params.data.id)) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      try {
        // Supersede via the dedicated path so the previous_proposal_id link
        // also gets set when caller passes supersededByProposalId.
        if (body.data.status === 'superseded' || body.data.supersededByProposalId !== undefined) {
          service.supersedeProposal(
            params.data.id,
            body.data.supersededByProposalId ?? null,
            HTTP_ACTOR,
          )
        } else if (body.data.status !== undefined) {
          service.setProposalStatus(params.data.id, body.data.status, HTTP_ACTOR)
        }
      } catch (err) {
        reply.code(400)
        return {
          error: 'UPDATE_PROPOSAL_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }
      }
      return { proposal: service.getProposal(params.data.id) }
    })
  }

  // P4P5: render proposal markdown + (optional) pdf/docx via Pandoc.
  for (const url of bothPaths('/proposals/:id/render')) {
    app.post(url, async (req, reply) => {
      const params = ProposalIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const body = RenderBody.safeParse(req.body ?? {})
      if (!body.success) {
        reply.code(400)
        return { error: 'INVALID_BODY', details: body.error.flatten() }
      }
      const proposal = service.getProposal(params.data.id)
      if (!proposal) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!storageRoot) {
        reply.code(503)
        return { error: 'NO_STORAGE_ROOT' }
      }
      if (!proposal.renderedMarkdownPath) {
        reply.code(404)
        return { error: 'NO_RENDERED_MD' }
      }
      const mdAbs = resolveUnder(storageRoot, proposal.renderedMarkdownPath)
      if (!mdAbs) {
        reply.code(400)
        return { error: 'INVALID_RENDERED_PATH' }
      }
      const files: Array<{ path: string; kind: 'md' | 'pdf' | 'docx'; mtime: string; bytes: number }> = []
      const unavailable: Array<'pdf' | 'docx'> = []
      for (const fmt of body.data.formats) {
        if (fmt === 'md') {
          const s = await safeStat(mdAbs)
          if (s) {
            files.push({
              path: proposal.renderedMarkdownPath,
              kind: 'md',
              mtime: new Date(s.mtimeMs).toISOString(),
              bytes: s.size,
            })
          }
        } else {
          if (!pandocAvailable) {
            unavailable.push(fmt)
            continue
          }
          const dest = mdAbs.replace(/\.md$/i, `.${fmt}`)
          const result = await renderPandoc({
            inputFile: mdAbs,
            outputFile: dest,
          })
          if (result.kind !== 'ok') {
            unavailable.push(fmt)
            continue
          }
          const s = await safeStat(dest)
          if (s) {
            files.push({
              path: proposal.renderedMarkdownPath.replace(/\.md$/i, `.${fmt}`),
              kind: fmt,
              mtime: new Date(s.mtimeMs).toISOString(),
              bytes: s.size,
            })
          }
        }
      }
      return { files, unavailable }
    })
  }

  // P4P5: GET /api/proposals/:id/download/:format streams the rendered file.
  for (const url of bothPaths('/proposals/:id/download/:format')) {
    app.get(url, async (req, reply) => {
      const params = DownloadParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      const proposal = service.getProposal(params.data.id)
      if (!proposal) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      if (!storageRoot || !proposal.renderedMarkdownPath) {
        reply.code(404)
        return { error: 'NOT_RENDERED' }
      }
      if (params.data.format !== 'md' && !pandocAvailable) {
        reply.code(503)
        return { error: 'PANDOC_UNAVAILABLE' }
      }
      const relPath = proposal.renderedMarkdownPath.replace(/\.md$/i, `.${params.data.format}`)
      const abs = resolveUnder(storageRoot, relPath)
      if (!abs) {
        reply.code(400)
        return { error: 'INVALID_PATH' }
      }
      const s = await safeStat(abs)
      if (!s) {
        reply.code(404)
        return { error: 'NOT_RENDERED' }
      }
      const buf = await readFile(abs)
      const filename = basename(abs)
      reply.header(
        'Content-Type',
        params.data.format === 'md' ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
      )
      reply.header('Content-Disposition', `attachment; filename="${sanitiseFilename(filename)}"`)
      return reply.send(buf)
    })
  }

  // P4P8: combined history (audit + relevant events) for a proposal/estimate id.
  for (const url of bothPaths('/proposals/:id/history')) {
    app.get(url, async (req, reply) => {
      const params = ProposalIdParams.safeParse(req.params)
      if (!params.success) {
        reply.code(400)
        return { error: 'INVALID_PARAMS' }
      }
      if (!audit) {
        reply.code(503)
        return { error: 'AUDIT_UNAVAILABLE' }
      }
      const q = HistoryQuery.safeParse(req.query ?? {})
      const limit = q.success && q.data.limit !== undefined ? q.data.limit : 200
      const detail = service.getProposalDetail(params.data.id)
      if (!detail) {
        reply.code(404)
        return { error: 'NOT_FOUND' }
      }
      // Build the entity scope: the (proposal?), its (estimate), and any
      // predecessor estimates.
      const entries: ReturnType<typeof audit.listByEntity>[number][] = []
      if (detail.proposal) {
        entries.push(...audit.listByEntity('proposal', detail.proposal.id))
      }
      entries.push(...audit.listByEntity('estimate', detail.estimate.id))
      for (const pred of detail.predecessorEstimates) {
        entries.push(...audit.listByEntity('estimate', pred.id))
      }
      const mapped = entries
        .sort((a, b) => a.ts - b.ts)
        .slice(0, limit)
        .map((e) => ({
          ts: e.ts,
          actorKind: e.actor.type,
          module: e.module,
          action: e.action,
          fromStatus: null as string | null,
          toStatus: (e.payload && typeof e.payload === 'object' &&
            (e.payload as Record<string, unknown>).status !== undefined)
            ? String((e.payload as Record<string, unknown>).status)
            : null,
          details: (e.payload && typeof e.payload === 'object'
            ? e.payload
            : {}) as Record<string, unknown>,
        }))
      return { entries: mapped }
    })
  }
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Best-effort description extraction: prefers `README.md` inside the
 * template folder, else returns null. Cheap and fully optional.
 */
async function readTemplateDescription(folder: string): Promise<string | null> {
  const candidates = ['README.md', 'description.md', 'description.txt']
  for (const c of candidates) {
    try {
      const txt = await readFile(join(folder, c), 'utf-8')
      const firstLine = txt.split(/\r?\n/, 1)[0]?.trim() ?? ''
      return firstLine.length > 0 ? firstLine.slice(0, 240) : null
    } catch {
      // try the next
    }
  }
  return null
}

async function safeStat(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(p)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

function resolveUnder(root: string, rel: string): string | null {
  return confineToRoot(root, rel)
}

function sanitiseFilename(name: string): string {
  return name.replace(/[^\w.\-+ ]+/g, '_')
}
