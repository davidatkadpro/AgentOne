import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { loadSkillIndex } from '@/skills/loader.js'

const REPO = process.cwd()

describe('modules/invoicing/skills — loader discovery', () => {
  it('discovers create-invoice + record-payment with the expected tool ids', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'invoicing', root: join(REPO, 'modules', 'invoicing', 'skills') },
      ],
    })
    const create = idx.skills.get('invoicing/create-invoice')
    expect(create).toBeDefined()
    expect(create?.frontmatter.tools?.map((t) => t.id).sort()).toEqual([
      'create_invoice',
      'create_invoice_from_proposal',
    ])
    const pay = idx.skills.get('invoicing/record-payment')
    expect(pay).toBeDefined()
    expect(pay?.frontmatter.tools?.map((t) => t.id)).toEqual(['record_payment'])
  })

  it('slash commands /create-invoice and /record-payment are registered', async () => {
    const idx = await loadSkillIndex({
      root: join(REPO, 'skills'),
      moduleSkillRoots: [
        { module: 'invoicing', root: join(REPO, 'modules', 'invoicing', 'skills') },
      ],
    })
    expect(idx.bySlashCommand.get('create-invoice')?.qualifiedName).toBe(
      'invoicing/create-invoice',
    )
    expect(idx.bySlashCommand.get('record-payment')?.qualifiedName).toBe(
      'invoicing/record-payment',
    )
  })
})
