/**
 * Typed domain errors. Module services throw these instead of bare
 * `new Error(...)` so route handlers can do narrow `instanceof` mapping
 * rather than catching-then-mapping-everything-to-404.
 *
 * The historical pattern looked like:
 *
 *   try { service.setProjectStatus(id, status, ctx) }
 *   catch { reply.code(404); return { error: 'NOT_FOUND' } }
 *
 * which mapped every kind of failure — including DB constraint violations,
 * invariant breaks, and programmer mistakes — to a 404. That hid real bugs
 * and led callers to "retry not-found" loops on actual server errors.
 *
 * Migration strategy: services throw the typed errors below. Routes that
 * haven't been updated yet still fall through to Fastify's default error
 * handler, which now logs + 500s — louder than the old 404 but correct.
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

/** The requested entity does not exist (or the caller is not allowed to see it). */
export class NotFoundError extends DomainError {
  constructor(
    public readonly entity: string,
    public readonly id: string,
    message?: string,
  ) {
    super(message ?? `${entity} not found: ${id}`)
    this.name = 'NotFoundError'
  }
}

/** A state-machine transition that doesn't make sense from the current state. */
export class InvalidTransitionError extends DomainError {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
    message?: string,
  ) {
    super(message ?? `Cannot transition ${entity} from "${from}" to "${to}"`)
    this.name = 'InvalidTransitionError'
  }
}

/** A precondition fails — e.g. duplicate unique key, optimistic-lock conflict. */
export class ConflictError extends DomainError {
  constructor(
    public readonly entity: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

/**
 * Map a domain error to a Fastify response shape. Returns `null` if the
 * error isn't a known domain error — callers should re-throw to let
 * Fastify's default handler take over (so unexpected errors become loud
 * 500s instead of silent 404s).
 */
export interface DomainErrorMapping {
  status: number
  body: { error: string; entity?: string; message?: string }
}

export function mapDomainError(err: unknown): DomainErrorMapping | null {
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: 'NOT_FOUND', entity: err.entity, message: err.message } }
  }
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: { error: 'INVALID_TRANSITION', entity: err.entity, message: err.message },
    }
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: 'CONFLICT', entity: err.entity, message: err.message } }
  }
  return null
}
