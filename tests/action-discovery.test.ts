import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  discoverActions,
  registerModuleActionsDiscovery,
} from '@/modules/action-discovery.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentone-action-discovery-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function plantSkill(
  name: string,
  frontmatter: Record<string, unknown>,
  body = '',
): Promise<void> {
  const skillDir = join(dir, name)
  await mkdir(skillDir, { recursive: true })
  const fmYaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}`
      if (typeof v === 'boolean') return `${k}: ${v}`
      return `${k}: ${typeof v === 'string' && v.includes(':') ? `"${v}"` : v}`
    })
    .join('\n')
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${fmYaml}\n---\n\n${body}`, 'utf-8')
}

describe('discoverActions', () => {
  it('returns empty result when skills dir does not exist', async () => {
    const res = await discoverActions({ skillsDir: join(dir, 'missing') })
    expect(res).toEqual({ actions: [], errors: [] })
  })

  it('parses a single minimal skill into an action descriptor', async () => {
    await plantSkill('file-to-project', {
      name: 'file-to-project',
      description: 'File this email into the right project.',
    })
    const res = await discoverActions({ skillsDir: dir })
    expect(res.errors).toEqual([])
    expect(res.actions).toEqual([
      {
        name: 'file-to-project',
        label: 'File To Project',
        description: 'File this email into the right project.',
        icon: null,
        defaultProfile: null,
        requiresConfirmation: false,
        surface: 'ask_agent',
        tabs: [],
      },
    ])
  })

  it('honours all optional frontmatter fields', async () => {
    await plantSkill('mark-paid', {
      name: 'mark-paid',
      description: 'Mark an invoice as paid.',
      label: 'Mark paid',
      icon: 'check-circle',
      default_profile: 'ops',
      requires_confirmation: true,
      surface: 'action',
      tabs: ['invoices', 'overview'],
    })
    const res = await discoverActions({ skillsDir: dir })
    expect(res.actions[0]).toMatchObject({
      label: 'Mark paid',
      icon: 'check-circle',
      defaultProfile: 'ops',
      requiresConfirmation: true,
      surface: 'action',
      tabs: ['invoices', 'overview'],
    })
  })

  it('surfaces parse errors per-skill without crashing the panel', async () => {
    await plantSkill('good', { name: 'good', description: 'fine' })
    // Bad frontmatter: missing required `description`.
    await plantSkill('bad', { name: 'bad' })
    const res = await discoverActions({ skillsDir: dir })
    expect(res.actions.map((a) => a.name)).toEqual(['good'])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]!.skill).toBe('bad')
  })

  it('reports missing SKILL.md as an error', async () => {
    await mkdir(join(dir, 'empty-folder'), { recursive: true })
    const res = await discoverActions({ skillsDir: dir })
    expect(res.errors).toEqual([{ skill: 'empty-folder', error: 'SKILL.md missing' }])
  })

  it('sorts actions by name', async () => {
    await plantSkill('zeta', { name: 'zeta', description: 'last' })
    await plantSkill('alpha', { name: 'alpha', description: 'first' })
    const res = await discoverActions({ skillsDir: dir })
    expect(res.actions.map((a) => a.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('registerModuleActionsDiscovery', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  it('mounts GET /api/<module>/actions returning the discovery result', async () => {
    await plantSkill('file-to-project', {
      name: 'file-to-project',
      description: 'File this email.',
    })
    registerModuleActionsDiscovery(app, { module: 'email', skillsDir: dir })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/email/actions' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.actions[0].name).toBe('file-to-project')
  })

  it('returns { actions: [], errors: [] } when skills dir does not exist', async () => {
    registerModuleActionsDiscovery(app, {
      module: 'projects',
      skillsDir: join(dir, 'never-existed'),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/projects/actions' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ actions: [], errors: [] })
  })

  it('caches results until the skills dir mtime changes', async () => {
    await plantSkill('first', { name: 'first', description: 'a' })
    registerModuleActionsDiscovery(app, { module: 'email', skillsDir: dir })
    await app.ready()
    const a = await app.inject({ method: 'GET', url: '/api/email/actions' })
    expect(a.json().actions).toHaveLength(1)
    // Add a second skill — dropping a folder bumps the dir's mtime.
    await plantSkill('second', { name: 'second', description: 'b' })
    const b = await app.inject({ method: 'GET', url: '/api/email/actions' })
    expect(b.json().actions).toHaveLength(2)
  })

  it('mounts independent caches per module', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'agentone-mod-a-'))
    const dirB = await mkdtemp(join(tmpdir(), 'agentone-mod-b-'))
    try {
      await mkdir(join(dirA, 'a-skill'), { recursive: true })
      await writeFile(
        join(dirA, 'a-skill', 'SKILL.md'),
        '---\nname: a-skill\ndescription: A\n---\n',
        'utf-8',
      )
      await mkdir(join(dirB, 'b-skill'), { recursive: true })
      await writeFile(
        join(dirB, 'b-skill', 'SKILL.md'),
        '---\nname: b-skill\ndescription: B\n---\n',
        'utf-8',
      )
      registerModuleActionsDiscovery(app, { module: 'modA', skillsDir: dirA })
      registerModuleActionsDiscovery(app, { module: 'modB', skillsDir: dirB })
      await app.ready()
      const a = await app.inject({ method: 'GET', url: '/api/modA/actions' })
      const b = await app.inject({ method: 'GET', url: '/api/modB/actions' })
      expect(a.json().actions[0].name).toBe('a-skill')
      expect(b.json().actions[0].name).toBe('b-skill')
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })
})
