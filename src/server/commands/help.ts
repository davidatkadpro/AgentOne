import { z } from 'zod'
import type { CommandModule } from './types.js'

export function buildHelpCommand(getList: () => Array<{ name: string; usage: string; description: string }>): CommandModule {
  const args = z.object({})
  return {
    name: 'help',
    description: 'List all available commands.',
    usage: '/help',
    args,
    requiresSession: false,
    handler: async () => {
      const list = getList()
      const skillList = list
        .map((c) => `  /${c.name} — ${c.description}\n      usage: ${c.usage}`)
        .join('\n')
      return {
        kind: 'text',
        content: `Available commands:\n${skillList}`,
      }
    },
  }
}
