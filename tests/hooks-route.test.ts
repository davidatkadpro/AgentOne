import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import yaml from 'js-yaml'

interface Harness {
  app: FastifyInstance
  configDir: string
  hooksPath: string
}

/** A minimal mount of just the /api/hooks route, mirroring the wiring in
 *  src/server/index.ts. Pulled out into its own test harness so we don't
 *  need to bring up the full server (which depends on a model registry). */
async function mountHooksRoute(configPath: string | null): Promise<FastifyInstance> {
  const { readFile } = await import('node:fs/promises')
  const app = Fastify({ logger: false })
  app.get('/api/hooks', async () => {
    if (!configPath) return { hooks: [], configPath: null }
    try {
      const raw = await readFile(configPath, 'utf-8')
      const parsed = yaml.load(raw)
      if (!Array.isArray(parsed)) {
        return { hooks: [], configPath, error: 'NOT_A_LIST' }
      }
      const hooks = (parsed as Array<Record<string, unknown>>)
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          event: typeof e.on === 'string' ? e.on : '*',
          handler: typeof e.handler === 'string' ? e.handler : '',
          description: typeof e.description === 'string' ? e.description : null,
          enabled: e.enabled !== false,
        }))
        .filter((h) => h.handler.length > 0)
      return { hooks, configPath }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { hooks: [], configPath }
      }
      return {
        hooks: [],
        configPath,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })
  await app.ready()
  return app
}

async function newHarness(): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), 'agentone-hooks-'))
  const hooksPath = join(configDir, 'hooks.yaml')
  const app = await mountHooksRoute(hooksPath)
  return { app, configDir, hooksPath }
}

describe('GET /api/hooks', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await h.app.close()
    await rm(h.configDir, { recursive: true, force: true })
  })

  it('returns hooks: [] when EVENT_HOOKS_PATH is unset', async () => {
    const app = await mountHooksRoute(null)
    const res = await app.inject({ method: 'GET', url: '/api/hooks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hooks: [], configPath: null })
    await app.close()
  })

  it('returns hooks: [] when the file does not exist', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/hooks' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { hooks: unknown[]; configPath: string }
    expect(body.hooks).toEqual([])
    expect(body.configPath).toBe(h.hooksPath)
  })

  it('parses a valid hooks file', async () => {
    await writeFile(
      h.hooksPath,
      yaml.dump([
        { on: 'project.created', handler: './log.js', description: 'log new projects' },
        { on: '*', handler: './audit.js' },
      ]),
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/hooks' })
    const body = res.json() as { hooks: Array<{ event: string; handler: string; enabled: boolean }> }
    expect(body.hooks).toHaveLength(2)
    expect(body.hooks[0]?.event).toBe('project.created')
    expect(body.hooks[0]?.handler).toBe('./log.js')
    expect(body.hooks[1]?.event).toBe('*')
    expect(body.hooks.every((h) => h.enabled)).toBe(true)
  })

  it('respects enabled: false', async () => {
    await writeFile(
      h.hooksPath,
      yaml.dump([
        { on: 'task.created', handler: './a.js' },
        { on: 'task.completed', handler: './b.js', enabled: false },
      ]),
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/hooks' })
    const body = res.json() as { hooks: Array<{ enabled: boolean; handler: string }> }
    expect(body.hooks.find((h) => h.handler === './a.js')?.enabled).toBe(true)
    expect(body.hooks.find((h) => h.handler === './b.js')?.enabled).toBe(false)
  })

  it('returns NOT_A_LIST error when the file is not a YAML array', async () => {
    await writeFile(h.hooksPath, yaml.dump({ on: 'project.created' }))
    const res = await h.app.inject({ method: 'GET', url: '/api/hooks' })
    const body = res.json() as { hooks: unknown[]; error?: string }
    expect(body.hooks).toEqual([])
    expect(body.error).toBe('NOT_A_LIST')
  })

  it('drops entries with missing handler', async () => {
    await writeFile(
      h.hooksPath,
      yaml.dump([{ on: 'task.created' }, { on: 'task.created', handler: './ok.js' }]),
    )
    const res = await h.app.inject({ method: 'GET', url: '/api/hooks' })
    const body = res.json() as { hooks: Array<{ handler: string }> }
    expect(body.hooks).toHaveLength(1)
    expect(body.hooks[0]?.handler).toBe('./ok.js')
  })
})
