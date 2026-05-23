import { z } from 'zod'
import type { RegisteredTool } from './tool.js'
import { ok } from './tool.js'

const RequestUserInputParams = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'A clear, self-contained question to surface to the user. Becomes the notification title.',
    ),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.string().min(1),
      }),
    )
    .optional()
    .describe(
      'Optional structured choices the UI may render as buttons. The user can still reply free-form.',
    ),
})

/**
 * Core Tool that pauses the session until the user replies. The handler:
 *   1. flips session.state to 'awaiting_input'
 *   2. creates an 'attention_needed' notification carrying the question and
 *      any structured options
 *   3. emits session.awaiting_input on the event bus
 * The orchestrator observes the awaiting_input state at the next turn boundary
 * and stops scheduling new model calls until a user message resumes the
 * session. See [[adr-0005-non-chat-session-activation]].
 */
export function buildRequestUserInputTool(): RegisteredTool {
  return {
    id: 'request_user_input',
    description:
      'Pause this session and ask the user a question. Use when you genuinely need a human decision before continuing — not for routine clarification you could derive yourself. The session resumes when the user replies.',
    parameters: RequestUserInputParams,
    handler: async (args, ctx) => {
      ctx.services.conversationStore.setSessionState(ctx.sessionId, 'awaiting_input')

      const notification = ctx.services.notifications.create({
        kind: 'attention_needed',
        title: args.question,
        body: args.question,
        sessionId: ctx.sessionId,
        payload: args.options ? { options: args.options } : {},
      })

      await ctx.services.eventBus.emit({
        type: 'session.awaiting_input',
        sessionId: ctx.sessionId,
        notificationId: notification.id,
        question: args.question,
        ts: Date.now(),
      })

      return ok({
        notification_id: notification.id,
        state: 'awaiting_input' as const,
      })
    },
    source: 'core',
  }
}
