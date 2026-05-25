import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  mapDomainError,
} from '../src/errors/domain.js'

describe('domain errors', () => {
  it('NotFoundError carries entity + id', () => {
    const err = new NotFoundError('project', 'p-1')
    expect(err.name).toBe('NotFoundError')
    expect(err.entity).toBe('project')
    expect(err.id).toBe('p-1')
    expect(err.message).toContain('project not found: p-1')
  })

  it('InvalidTransitionError captures from/to', () => {
    const err = new InvalidTransitionError('invoice', 'paid', 'draft')
    expect(err.from).toBe('paid')
    expect(err.to).toBe('draft')
    expect(err.message).toMatch(/paid.*draft/)
  })

  it('ConflictError exposes entity + message', () => {
    const err = new ConflictError('project', 'duplicate number 25001')
    expect(err.entity).toBe('project')
    expect(err.message).toBe('duplicate number 25001')
  })
})

describe('mapDomainError', () => {
  it('maps NotFoundError → 404', () => {
    const m = mapDomainError(new NotFoundError('project', 'p-1'))
    expect(m?.status).toBe(404)
    expect(m?.body.error).toBe('NOT_FOUND')
    expect(m?.body.entity).toBe('project')
  })

  it('maps InvalidTransitionError → 409', () => {
    const m = mapDomainError(new InvalidTransitionError('invoice', 'paid', 'draft'))
    expect(m?.status).toBe(409)
    expect(m?.body.error).toBe('INVALID_TRANSITION')
  })

  it('maps ConflictError → 409', () => {
    const m = mapDomainError(new ConflictError('proposal', 'duplicate number'))
    expect(m?.status).toBe(409)
    expect(m?.body.error).toBe('CONFLICT')
  })

  it('returns null for non-domain errors so they propagate', () => {
    expect(mapDomainError(new Error('boom'))).toBeNull()
    expect(mapDomainError('not even an error')).toBeNull()
    expect(mapDomainError(null)).toBeNull()
  })
})
