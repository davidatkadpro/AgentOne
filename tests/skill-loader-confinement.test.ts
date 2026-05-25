import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importSkillTools,
  loadSkillIndex,
} from '@/skills/loader.js'

let root: string

async function plantSkillFile(
  category: string,
  name: string,
  handlerPath: string,
): Promise<void> {
  const folder = join(root, category, name)
  await mkdir(folder, { recursive: true })
  await mkdir(join(folder, 'tools'), { recursive: true })
  await writeFile(
    join(folder, 'tools', 'good.ts'),
    `import { z } from 'zod'\nexport const parameters = z.object({})\nexport const handler = async () => ({ ok: true, value: null })\nexport default { parameters, handler }\n`,
  )
  const yaml = [
    `name: ${name}`,
    'description: test',
    'tools:',
    `  - id: ${name}_run`,
    `    handler: ${handlerPath}`,
    `    description: t`,
  ].join('\n')
  await writeFile(join(folder, 'SKILL.md'), `---\n${yaml}\n---\n\n# ${name}\n`)
  await writeFile(
    join(root, category, 'CATEGORY.md'),
    `---\nname: ${category}\ndescription: test\n---\n`,
  )
}

describe('skill loader — handler path confinement (index-time + import-time)', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentone-skill-confine-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a handler under tools/ and loads it', async () => {
    await plantSkillFile('system', 'a', './tools/good.ts')
    const idx = await loadSkillIndex({ root })
    const m = idx.skills.get('system/a')
    expect(m).toBeDefined()
    const tools = await importSkillTools(m!)
    expect(tools).toHaveLength(1)
  })

  it('index load rejects an absolute handler path', async () => {
    await plantSkillFile(
      'system',
      'b',
      process.platform === 'win32' ? 'C:\\evil.ts' : '/etc/evil.ts',
    )
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'INVALID_HANDLER_PATH',
    })
  })

  it('index load rejects a `..` escape', async () => {
    await plantSkillFile('system', 'c', '../../../leak.ts')
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'INVALID_HANDLER_PATH',
    })
  })

  it('index load rejects a sibling-prefix escape', async () => {
    await plantSkillFile('system', 'd', '../other-skill/tool.ts')
    await expect(loadSkillIndex({ root })).rejects.toMatchObject({
      code: 'INVALID_HANDLER_PATH',
    })
  })

  it('accepts nested subfolders within the skill', async () => {
    await plantSkillFile('system', 'e', 'tools/good.ts')
    const idx = await loadSkillIndex({ root })
    const m = idx.skills.get('system/e')
    expect(m).toBeDefined()
    const tools = await importSkillTools(m!)
    expect(tools[0]?.id).toBe('e_run')
  })
})
