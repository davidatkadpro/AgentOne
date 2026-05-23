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

  it('discoverEmailActions returns file-to-project from the real skills folder', async () => {
    const result = await discoverEmailActions(
      join(REPO, 'modules', 'email', 'skills'),
    )
    expect(result.errors).toEqual([])
    const file = result.actions.find((a) => a.name === 'file-to-project')
    expect(file).toBeDefined()
    expect(file?.label).toBe('File to project')
    expect(file?.surface).toBe('action')
    expect(file?.tabs).toEqual(['emails'])
  })
})
