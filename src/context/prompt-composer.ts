import type { Message } from '../core/types.js'

export interface PromptInputs {
  basePrompt: string
  agentProfilePrompt?: string
  defaultSkills?: Array<{ name: string; description: string; path: string }>
  categories?: Array<{ name: string; description: string }>
  storageLayoutHint?: string
}

const SEPARATOR = '\n---\n\n'

/**
 * Pure function. Given the static inputs that define a session's system prompt,
 * produces the composed system message. Mirrors the structure in
 * [docs/PRD.md](../../docs/PRD.md): base → agent profile → default skills →
 * categories → storage hint.
 */
export function composeSystemMessage(inputs: PromptInputs): Message {
  const parts: string[] = []
  parts.push(inputs.basePrompt.trim())

  if (inputs.agentProfilePrompt && inputs.agentProfilePrompt.trim()) {
    parts.push(inputs.agentProfilePrompt.trim())
  }

  if (inputs.defaultSkills && inputs.defaultSkills.length > 0) {
    const body = inputs.defaultSkills
      .map((s) => `- ${s.name}: ${s.description} [${s.path}]`)
      .join('\n')
    parts.push(`## Default skills\n\n${body}`)
  }

  if (inputs.categories && inputs.categories.length > 0) {
    const body = inputs.categories.map((c) => `- ${c.name}: ${c.description}`).join('\n')
    parts.push(`## Skill categories (use list_skills to explore)\n\n${body}`)
  }

  if (inputs.storageLayoutHint && inputs.storageLayoutHint.trim()) {
    parts.push(`## Storage layout\n\n${inputs.storageLayoutHint.trim()}`)
  }

  return { role: 'system', content: parts.join(SEPARATOR) }
}
