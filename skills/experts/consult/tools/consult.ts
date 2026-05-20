import { z } from 'zod'
import type { ToolHandler } from '../../../../src/skills/tool.js'
import { fail, ok } from '../../../../src/skills/tool.js'
import { ProviderError } from '../../../../src/providers/base.js'
import type { Message } from '../../../../src/core/types.js'

export const parameters = z.object({
  expert: z
    .string()
    .min(1)
    .describe('Model Profile id of the expert to consult (must be role=expert and in the agent profile allow-list)'),
  question: z.string().min(1).describe('The specific question to answer'),
  context: z
    .string()
    .min(1)
    .describe('Background the expert needs to answer — user ask, code, failing attempts, relevant history'),
  system: z
    .string()
    .optional()
    .describe('Optional short framing message ("you are a senior reviewer ...")'),
  max_tokens: z
    .number()
    .int()
    .positive()
    .max(8192)
    .optional()
    .describe('Response token cap (default 2048)'),
})

export const handler: ToolHandler<typeof parameters> = async (args, ctx) => {
  const expertProfile = ctx.services.modelProfiles.get(args.expert)
  if (!expertProfile) {
    return fail('TOOL_VALIDATION', `No Model Profile with id "${args.expert}"`, true)
  }
  if (expertProfile.role !== 'expert') {
    return fail(
      'TOOL_VALIDATION',
      `Model Profile "${args.expert}" has role="${expertProfile.role}", not "expert"`,
      true,
    )
  }

  const permissionCheck = ctx.permissions.canCallExpert(args.expert)
  if (permissionCheck.verdict === 'deny') {
    return fail(
      'PERMISSION_DENIED',
      `Agent profile does not allow consulting "${args.expert}": ${permissionCheck.reason}`,
      false,
    )
  }

  const sessionBudget = ctx.permissions.budgetPerSessionUsd()
  if (sessionBudget !== null && ctx.expertSpend.total >= sessionBudget) {
    return fail(
      'BUDGET_EXCEEDED',
      `Session expert budget ($${sessionBudget.toFixed(4)}) already spent ` +
        `($${ctx.expertSpend.total.toFixed(4)}). Refusing further consults.`,
      false,
    )
  }

  const provider = ctx.services.providers.find(expertProfile.provider)
  if (!provider) {
    return fail(
      'RESOURCE_UNAVAILABLE',
      `Provider "${expertProfile.provider}" for expert "${args.expert}" is not configured ` +
        `(missing API key or registration). Available: ${ctx.services.providers.ids().join(', ')}.`,
      false,
    )
  }

  const messages: Message[] = []
  if (args.system) messages.push({ role: 'system', content: args.system })
  messages.push({ role: 'user', content: `${args.context}\n\n---\n\n${args.question}` })

  try {
    const res = await provider.chat({
      model: expertProfile.model,
      messages,
      temperature: expertProfile.params.temperature ?? 0.4,
      maxTokens: args.max_tokens ?? expertProfile.params.maxTokens ?? 2048,
      topP: expertProfile.params.topP ?? 1,
    })

    const cost = res.costUsd ?? 0
    ctx.expertSpend.add(args.expert, cost)

    await ctx.services.eventBus.emit({
      type: 'expert.consulted',
      sessionId: ctx.sessionId,
      expert: args.expert,
      model: expertProfile.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUsd: cost,
      sessionSpendUsd: ctx.expertSpend.total,
      ts: Date.now(),
    })

    const perCallBudget = ctx.permissions.budgetPerCallUsd()
    if (perCallBudget !== null && cost > perCallBudget) {
      await ctx.services.eventBus.emit({
        type: 'expert.budget_exceeded',
        sessionId: ctx.sessionId,
        expert: args.expert,
        costUsd: cost,
        perCallBudgetUsd: perCallBudget,
        ts: Date.now(),
      })
    }

    return ok({
      expert: args.expert,
      reply: res.content,
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
      cost_usd: cost,
      session_spend_usd: ctx.expertSpend.total,
    })
  } catch (err) {
    if (err instanceof ProviderError) {
      const recoverable = err.code === 'NETWORK' || err.code === 'RATE_LIMITED' || err.code === 'TIMEOUT'
      return fail('TOOL_RUNTIME', `Expert call failed (${err.code}): ${err.message}`, recoverable)
    }
    return fail('TOOL_RUNTIME', err instanceof Error ? err.message : String(err), false)
  }
}
