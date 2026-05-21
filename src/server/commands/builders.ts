import { CommandRegistry } from './registry.js'
import { buildHelpCommand } from './help.js'
import { sessionsCommand } from './sessions.js'
import { newCommand } from './new.js'
import { clearCommand } from './clear.js'
import { compactCommand } from './compact.js'
import { loadCommand } from './load.js'
import { costCommand } from './cost.js'
import { distillCommand } from './distill.js'
import { backupCommand } from './backup.js'
import type { SkillIndex } from '../../skills/loader.js'

/**
 * Factory: registers the six built-in system commands plus a /help that
 * dynamically lists the rest (including skill-declared slash commands).
 */
export function buildCommandRegistry(skillIndex: SkillIndex): CommandRegistry {
  const reg = new CommandRegistry()
  reg.register(sessionsCommand)
  reg.register(newCommand)
  reg.register(clearCommand)
  reg.register(compactCommand)
  reg.register(loadCommand)
  reg.register(costCommand)
  reg.register(distillCommand)
  reg.register(backupCommand)
  // /help lists everything including skill slash commands.
  reg.register(
    buildHelpCommand(() => {
      const built = reg.list().map((c) => ({
        name: c.name,
        usage: c.usage,
        description: c.description,
      }))
      const skillSlashes = [...skillIndex.bySlashCommand.values()].map((m) => ({
        name: m.slashCommand as string,
        usage: `/${m.slashCommand} [text]`,
        description: `${m.description} (loads skill ${m.qualifiedName}, then forwards text as a user message)`,
      }))
      return [...built, ...skillSlashes].sort((a, b) => a.name.localeCompare(b.name))
    }),
  )
  return reg
}
