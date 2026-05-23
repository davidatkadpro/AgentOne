import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadSkillIndex } from '@/skills/loader.js'
import { discoverEmailActions } from '../modules/email/src/actions.js'

const REPO = process.cwd()

describe('modules/email/skills', () => {
  it('file-to-project SKILL.md parses via the loader (module-scoped)', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'email', root: join(REPO, 'modules', 'email', 'skills') },
      ],
    })
    const manifest = idx.skills.get('email/file-to-project')
    expect(manifest).toBeDefined()
    expect(manifest?.frontmatter.tools?.map((t) => t.id)).toEqual(
      expect.arrayContaining(['list_projects_for_match', 'file_email_to_project']),
    )
  })

  it('discoverEmailActions returns all 3 email actions from the real skills folder', async () => {
    const result = await discoverEmailActions(
      join(REPO, 'modules', 'email', 'skills'),
    )
    expect(result.errors).toEqual([])
    const names = result.actions.map((a) => a.name).sort()
    expect(names).toEqual([
      'create-new-project',
      'file-to-project',
      'scope-extractor',
    ])
  })

  it('create-new-project SKILL.md parses with all three tool handlers present', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'email', root: join(REPO, 'modules', 'email', 'skills') },
      ],
    })
    const manifest = idx.skills.get('email/create-new-project')
    expect(manifest).toBeDefined()
    expect(manifest?.frontmatter.tools?.map((t) => t.id).sort()).toEqual([
      'create_project',
      'file_email_to_project',
      'suggest_next_project_number',
    ])
  })
})
