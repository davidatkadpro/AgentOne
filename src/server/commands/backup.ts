import { z } from 'zod'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineCommand } from './types.js'
import { backupDatabase } from '../../storage/backup.js'

const args = z.object({
  /** Optional override for the destination — file path or directory. */
  destination: z.string().optional(),
})

export const backupCommand = defineCommand({
  name: 'backup',
  description:
    'Snapshot the SQLite database to a timestamped file. Use this before risky operations (schema migrations, batch wipes) or as a scheduled habit. Concurrent writers see a consistent snapshot.',
  usage: '/backup [destination]',
  args,
  requiresSession: false,
  handler: async (parsed, ctx) => {
    const dest = parsed.destination ?? join(ctx.config.storageRoot, 'backups')
    try {
      const result = await backupDatabase(ctx.db, { destination: dest })
      const info = await stat(result.path).catch(() => null)
      const bytes = info?.size ?? result.bytes
      return {
        kind: 'text',
        content: renderBackupSummary({ path: result.path, bytes, durationMs: result.durationMs }),
      }
    } catch (err) {
      return {
        kind: 'error',
        message: `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      }
    }
  },
})

export function renderBackupSummary(input: {
  path: string
  bytes: number
  durationMs: number
}): string {
  const kb = (input.bytes / 1024).toFixed(1)
  return `Backed up to ${input.path}\n  ${kb} kB in ${input.durationMs} ms`
}
