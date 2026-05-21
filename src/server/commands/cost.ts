import { z } from 'zod'
import { defineCommand } from './types.js'
import { loadAgentProfile } from '../../profiles/agent-profile.js'

const args = z.object({})

export const costCommand = defineCommand({
  name: 'cost',
  description:
    'Show expert spend — this session and lifetime — plus the agent profile budgets.',
  usage: '/cost',
  args,
  requiresSession: true,
  handler: async (_parsed, ctx) => {
    const sessionId = ctx.sessionId as string
    const session = ctx.store.getSession(sessionId)
    if (!session) {
      return { kind: 'error', message: `Session not found: ${sessionId}`, recoverable: false }
    }

    const sessionSpend = ctx.store.sumExpertSpend({ sessionId })
    const lifetimeSpend = ctx.store.sumExpertSpend()

    // Re-resolve the agent profile for budget context. The orchestrator
    // already has it, but routing the budget through CommandContext would
    // require new plumbing; loading here is cheap and idempotent. Tolerate
    // load failure (profile renamed, dir misconfigured) — the spend report
    // is still useful without budget context.
    let perCallUsd: number | null = null
    let perSessionUsd: number | null = null
    let budgetAvailable = false
    try {
      const profile = await loadAgentProfile(
        ctx.config.agentProfilesDir,
        session.agentProfile,
      )
      perCallUsd = profile.permissions.experts.budgetPerCallUsd
      perSessionUsd = profile.permissions.experts.budgetPerSessionUsd
      budgetAvailable = true
    } catch {
      // Budget section will render as "unavailable".
    }
    const sessionRemainingUsd =
      perSessionUsd === null ? null : Math.max(0, perSessionUsd - sessionSpend.totalUsd)

    return {
      kind: 'text',
      content: renderCostReport({
        sessionSpend,
        lifetimeSpend,
        budget: budgetAvailable
          ? { perCallUsd, perSessionUsd, sessionRemainingUsd }
          : null,
      }),
    }
  },
})

interface Aggregated {
  totalUsd: number
  totalCalls: number
  byModel: Array<{ model: string; calls: number; costUsd: number }>
}

interface BudgetView {
  perCallUsd: number | null
  perSessionUsd: number | null
  sessionRemainingUsd: number | null
}

export function renderCostReport(report: {
  sessionSpend: Aggregated
  lifetimeSpend: Aggregated
  budget: BudgetView | null
}): string {
  const lines: string[] = []
  lines.push('Expert spend')
  lines.push('============')
  lines.push('')
  lines.push(
    `This session: ${formatUsd(report.sessionSpend.totalUsd)} ` +
      `(${report.sessionSpend.totalCalls} call${pl(report.sessionSpend.totalCalls)})`,
  )
  for (const m of report.sessionSpend.byModel) {
    lines.push(`  - ${m.model}: ${m.calls} call${pl(m.calls)}, ${formatUsd(m.costUsd)}`)
  }
  if (report.sessionSpend.byModel.length === 0) {
    lines.push('  (no expert calls in this session yet)')
  }
  lines.push('')
  lines.push(
    `Lifetime:     ${formatUsd(report.lifetimeSpend.totalUsd)} ` +
      `(${report.lifetimeSpend.totalCalls} call${pl(report.lifetimeSpend.totalCalls)})`,
  )
  for (const m of report.lifetimeSpend.byModel) {
    lines.push(`  - ${m.model}: ${m.calls} call${pl(m.calls)}, ${formatUsd(m.costUsd)}`)
  }
  if (report.lifetimeSpend.byModel.length === 0) {
    lines.push('  (no expert calls recorded)')
  }
  lines.push('')
  lines.push('Budget (from agent profile):')
  if (report.budget === null) {
    lines.push('  (unavailable — could not load agent profile)')
  } else {
    lines.push(
      `  per-call:    ${report.budget.perCallUsd === null ? 'unlimited' : formatUsd(report.budget.perCallUsd)}`,
    )
    if (report.budget.perSessionUsd === null) {
      lines.push('  per-session: unlimited')
    } else {
      lines.push(
        `  per-session: ${formatUsd(report.budget.perSessionUsd)} ` +
          `(${formatUsd(report.budget.sessionRemainingUsd ?? 0)} remaining)`,
      )
    }
  }
  return lines.join('\n')
}

function formatUsd(n: number): string {
  // Six decimals tracks fractional-cent expert calls (e.g. $0.000144).
  return `$${n.toFixed(6)}`
}

function pl(n: number): string {
  return n === 1 ? '' : 's'
}
