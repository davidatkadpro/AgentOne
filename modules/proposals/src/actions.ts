import type { FastifyInstance } from 'fastify'
import type { Orchestrator } from '../../../src/orchestrator/turn.js'
import type { EventBus } from '../../../src/core/events.js'
import { registerModuleActionDispatch } from '../../../src/modules/action-dispatch.js'
import type { ProjectsService } from '../../projects/src/service.js'

/**
 * Proposals-specific dispatch wiring. Mirrors `modules/email/src/actions.ts`
 * but resolves the entity as a Project row (proposals are project-scoped).
 * Discovery is registered globally via `registerModuleActionsDiscovery`.
 */

export interface RegisterProposalsActionsDeps {
  orchestrator: Orchestrator
  projects: ProjectsService
  /** Absolute path to `modules/proposals/skills/`. */
  skillsDir: string
  eventBus?: EventBus
}

export async function registerProposalsActions(
  app: FastifyInstance,
  deps: RegisterProposalsActionsDeps,
): Promise<void> {
  type Project = NonNullable<ReturnType<ProjectsService['getProject']>>
  await registerModuleActionDispatch<Project>(app, {
    module: 'proposals',
    urls: ['/api/v1/proposals/actions', '/api/proposals/actions'],
    skillsDir: deps.skillsDir,
    orchestrator: deps.orchestrator,
    lookup: (contextId) => deps.projects.getProject(contextId) ?? null,
    notFoundError: 'PROJECT_NOT_FOUND',
    scopeBuilder: (project, contextId, args) => ({
      project: {
        id: project.id,
        number: project.number,
        name: project.name,
        client: project.client,
        folderPath: project.folderPath,
      },
      contextId,
      args,
    }),
  })
}
