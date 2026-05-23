import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillIndex, SkillLoadError } from '@/skills/loader.js'

let root: string

async function makeSkill(opts: {
  category: string
  name: string
  frontmatter: string
  body?: string
  withHandler?: { rel: string; contents: string }
}) {
  const folder = join(root, opts.category, opts.name)
  await mkdir(folder, { recursive: true })
  const body = opts.body ?? '# ' + opts.name
  await writeFile(join(folder, 'SKILL.md'), `---\n${opts.frontmatter}\n---\n\n${body}\n`)
  if (opts.withHandler) {
    const handlerPath = join(folder, opts.withHandler.rel)
    await mkdir(join(folder, opts.withHandler.rel, '..'), { recursive: true })
    await writeFile(handlerPath, opts.withHandler.contents)
  }
}

async function makeCategory(name: string, description: string) {
  const folder = join(root, name)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'CATEGORY.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )
}

describe('loadSkillIndex', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentone-skills-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns empty index when root is empty', async () => {
    const idx = await loadSkillIndex({ root })
    expect(idx.skills.size).toBe(0)
    expect(idx.categories.size).toBe(0)
  })

  it('returns empty index when root does not exist', async () => {
    const idx = await loadSkillIndex({ root: join(root, 'does-not-exist') })
    expect(idx.skills.size).toBe(0)
  })

  it('discovers a single prose-only skill with no tools', async () => {
    await makeCategory('system', 'System category')
    await makeSkill({
      category: 'system',
      name: 'memory',
      frontmatter: 'name: memory\ndescription: Memory heuristics.',
    })
    const idx = await loadSkillIndex({ root })
    expect(idx.skills.size).toBe(1)
    expect(idx.categories.size).toBe(1)
    const skill = idx.skills.get('system/memory')
    expect(skill?.name).toBe('memory')
    expect(skill?.category).toBe('system')
    expect(skill?.description).toBe('Memory heuristics.')
  })

  it('rejects SKILL.md whose frontmatter name disagrees with the folder', async () => {
    await makeSkill({
      category: 'system',
      name: 'filesystem',
      frontmatter: 'name: not-filesystem\ndescription: x',
    })
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'INVALID_FRONTMATTER',
    })
  })

  it('rejects SKILL.md with a non-kebab-case name', async () => {
    await mkdir(join(root, 'system', 'Bad_Name'), { recursive: true })
    await writeFile(
      join(root, 'system', 'Bad_Name', 'SKILL.md'),
      '---\nname: Bad_Name\ndescription: x\n---\n',
    )
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'INVALID_FRONTMATTER',
    })
  })

  it('rejects when a declared handler file is missing', async () => {
    await makeSkill({
      category: 'system',
      name: 'broken',
      frontmatter: `name: broken
description: missing handler
tools:
  - id: do-thing
    handler: ./tools/missing.ts
    description: never imported`,
    })
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'MISSING_HANDLER',
    })
  })

  it('rejects a slash_command that collides with a reserved system command', async () => {
    await makeSkill({
      category: 'misc',
      name: 'helper',
      frontmatter: `name: helper
description: x
slash_command: help`,
    })
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'SLASH_COLLISION',
    })
  })

  it('rejects two skills claiming the same slash_command', async () => {
    await makeSkill({
      category: 'cat1',
      name: 'first',
      frontmatter: `name: first
description: x
slash_command: dig`,
    })
    await makeSkill({
      category: 'cat2',
      name: 'second',
      frontmatter: `name: second
description: x
slash_command: dig`,
    })
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'SLASH_COLLISION',
    })
  })

  it('CATEGORY.md mismatch with folder name throws', async () => {
    await mkdir(join(root, 'system'), { recursive: true })
    await writeFile(
      join(root, 'system', 'CATEGORY.md'),
      `---\nname: misc\ndescription: x\n---\n`,
    )
    await expect(loadSkillIndex({ root })).rejects.toBeInstanceOf(SkillLoadError)
  })

  it('indexes a skill with a declared tool and a real handler file', async () => {
    await makeSkill({
      category: 'system',
      name: 'shellish',
      frontmatter: `name: shellish
description: runs things
tools:
  - id: do-it
    handler: ./tools/do-it.ts
    description: example`,
      withHandler: {
        rel: 'tools/do-it.ts',
        contents:
          "import { z } from 'zod'\nexport const parameters = z.object({})\nexport const handler = async () => ({ ok: true, value: 'ok' })\nexport default { parameters, handler }\n",
      },
    })
    const idx = await loadSkillIndex({ root })
    const skill = idx.skills.get('system/shellish')
    expect(skill).toBeDefined()
    expect(skill?.frontmatter.tools?.[0]?.id).toBe('do-it')
  })

  it('builds slash_command lookup', async () => {
    await makeSkill({
      category: 'research',
      name: 'deep-dive',
      frontmatter: `name: deep-dive
description: x
slash_command: dive`,
    })
    const idx = await loadSkillIndex({ root })
    expect(idx.bySlashCommand.get('dive')?.qualifiedName).toBe('research/deep-dive')
  })

  it('discovers Module-scoped skills via moduleSkillRoots and namespaces them by module', async () => {
    const moduleSkillsDir = join(root, '_mod', 'projects', 'skills')
    await mkdir(join(moduleSkillsDir, 'create-project'), { recursive: true })
    await writeFile(
      join(moduleSkillsDir, 'create-project', 'SKILL.md'),
      `---\nname: create-project\ndescription: Create a new project.\n---\n\n# create-project\n`,
    )

    const idx = await loadSkillIndex({
      root,
      moduleSkillRoots: [{ module: 'projects', root: moduleSkillsDir }],
    })

    const manifest = idx.skills.get('projects/create-project')
    expect(manifest).toBeDefined()
    expect(manifest?.category).toBe('projects')
    expect(manifest?.name).toBe('create-project')
  })

  it('rejects qualifiedName collisions between top-level and Module skills', async () => {
    await makeCategory('projects', 'Top-level conflict')
    await makeSkill({
      category: 'projects',
      name: 'create-project',
      frontmatter: 'name: create-project\ndescription: top-level dup',
    })

    const moduleSkillsDir = join(root, '_mod', 'projects', 'skills')
    await mkdir(join(moduleSkillsDir, 'create-project'), { recursive: true })
    await writeFile(
      join(moduleSkillsDir, 'create-project', 'SKILL.md'),
      `---\nname: create-project\ndescription: module dup\n---\n\n# x\n`,
    )

    await expect(
      loadSkillIndex({
        root,
        moduleSkillRoots: [{ module: 'projects', root: moduleSkillsDir }],
      }),
    ).rejects.toBeInstanceOf(SkillLoadError)
  })
})
