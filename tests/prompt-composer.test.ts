import { describe, it, expect } from 'vitest'
import { composeSystemMessage } from '@/context/prompt-composer.js'

describe('composeSystemMessage', () => {
  it('returns base prompt only when no other inputs', () => {
    const msg = composeSystemMessage({ basePrompt: 'You are AgentOne.' })
    expect(msg.role).toBe('system')
    expect(msg.content).toBe('You are AgentOne.')
  })

  it('trims surrounding whitespace from each section', () => {
    const msg = composeSystemMessage({
      basePrompt: '   You are AgentOne.   \n\n',
      agentProfilePrompt: '\n  Researcher role.  \n',
    })
    expect(msg.content).toBe('You are AgentOne.\n---\n\nResearcher role.')
  })

  it('omits empty optional sections', () => {
    const msg = composeSystemMessage({
      basePrompt: 'base',
      agentProfilePrompt: '',
      defaultSkills: [],
      categories: [],
      storageLayoutHint: '',
    })
    expect(msg.content).toBe('base')
  })

  it('composes the full layered structure in fixed order', () => {
    const msg = composeSystemMessage({
      basePrompt: 'You are AgentOne.',
      agentProfilePrompt: 'You are a researcher.',
      defaultSkills: [
        { name: 'system/filesystem', description: 'read/write/edit files' },
        { name: 'system/memory', description: 'recall heuristics' },
      ],
      categories: [
        { name: 'system', description: 'foundational capabilities' },
        { name: 'research', description: 'research and citation tracking' },
      ],
      storageLayoutHint: 'wiki/ projects/ drafts/',
    })

    expect(msg.role).toBe('system')
    expect(msg.content).toMatchInlineSnapshot(`
      "You are AgentOne.
      ---

      You are a researcher.
      ---

      ## Default skills

      These skills are available but not pre-loaded — call \`load_skill\` with the name to use them.

      - system/filesystem: read/write/edit files
      - system/memory: recall heuristics
      ---

      ## Skill categories

      For skills beyond the defaults, call \`list_skills\` (optionally with \`category\` or \`query\`).

      - system: foundational capabilities
      - research: research and citation tracking
      ---

      ## Storage layout

      wiki/ projects/ drafts/"
    `)
  })

  it('preserves section ordering: base → profile → skills → categories → storage', () => {
    const msg = composeSystemMessage({
      basePrompt: 'A',
      agentProfilePrompt: 'B',
      defaultSkills: [{ name: 'x/y', description: 'z' }],
      categories: [{ name: 'cat', description: 'desc' }],
      storageLayoutHint: 'storage',
    })

    const content = msg.content ?? ''
    const idxBase = content.indexOf('A')
    const idxProfile = content.indexOf('B')
    const idxSkills = content.indexOf('Default skills')
    const idxCategories = content.indexOf('Skill categories')
    const idxStorage = content.indexOf('Storage layout')

    expect(idxBase).toBeLessThan(idxProfile)
    expect(idxProfile).toBeLessThan(idxSkills)
    expect(idxSkills).toBeLessThan(idxCategories)
    expect(idxCategories).toBeLessThan(idxStorage)
  })
})
