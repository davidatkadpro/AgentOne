import { z } from 'zod'
import type { Provider } from '../providers/base.js'
import type { Message } from '../core/types.js'

export const DistilledKindEnum = z.enum([
  'preference',
  'project',
  'decision',
  'definition',
  'reference',
])

export type DistilledKind = z.infer<typeof DistilledKindEnum>

export const DistilledNoteSchema = z.object({
  kind: DistilledKindEnum,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
})

export type DistilledNote = z.infer<typeof DistilledNoteSchema>

const DistilledArraySchema = z.array(DistilledNoteSchema)

const DISTILLER_SYSTEM_PROMPT = `You extract durable facts from a conversation transcript that are worth remembering across sessions.

For each fact, emit a JSON object with these fields:
- kind: one of "preference", "project", "decision", "definition", "reference"
- title: a short noun phrase, 5-15 words
- body: 1-3 sentences of detail

Categories:
- preference: the user's stated preferences, opinions, or working style ("prefers TypeScript over JavaScript", "wants concise summaries")
- project: factual claims about the project / environment / codebase that aren't already in the repo ("storage root is OneDrive at <path>", "deployed via Vercel")
- decision: choices made and the reason ("chose OpenRouter over Anthropic direct because budget control matters more than direct billing")
- definition: terminology specific to this project ("passive recall = auto-inject relevant wiki + cross-session history into the prompt")
- reference: external systems, URLs, paths, dashboards ("Linear board 'INGEST' tracks pipeline bugs")

Skip:
- ephemeral debugging chatter or task-specific scratch work
- tool call outputs (those are persisted elsewhere)
- code that's now in the repo (the repo is the source of truth)
- conversational filler ("ok", "sounds good", "let me think")
- restatements of well-known general knowledge

Return ONLY a JSON array. No prose, no markdown fences. If nothing is worth keeping, return [].`

export interface DistillConfig {
  /** Used to label the transcript turns. */
  roleLabels?: Partial<Record<Message['role'], string>>
  /** Truncation cap on transcript characters sent to the model. */
  maxTranscriptChars?: number
  /** Provider chat() temperature. Default 0.1 — we want consistency, not creativity. */
  temperature?: number
  /** Maximum response tokens. Default 1200 — enough for ~20 short notes. */
  maxTokens?: number
}

export interface DistillResult {
  notes: DistilledNote[]
  /** Raw model output, surfaced so a caller can debug a zero-note result. */
  rawResponse: string
  inputTokens: number
  outputTokens: number
  /** True when the response contained non-JSON content we had to strip. */
  reparseUsed: boolean
}

const DEFAULT_ROLE_LABELS: Record<Message['role'], string> = {
  system: 'SYSTEM',
  user: 'USER',
  assistant: 'ASSISTANT',
  tool: 'TOOL',
}

/**
 * Run the distiller against a conversation transcript. Returns the
 * structured notes plus the raw response for debugging. Throws only on a
 * hard provider error — JSON parse failures degrade to an empty notes list
 * (with `rawResponse` populated so the caller can surface what happened).
 */
export async function distill(
  transcript: Message[],
  provider: Provider,
  model: string,
  cfg: DistillConfig = {},
): Promise<DistillResult> {
  const labels = { ...DEFAULT_ROLE_LABELS, ...(cfg.roleLabels ?? {}) }
  const maxChars = cfg.maxTranscriptChars ?? 20000

  const lines: string[] = []
  for (const m of transcript) {
    const content = m.content ?? ''
    if (content.length === 0) continue
    lines.push(`${labels[m.role]}: ${content}`)
  }
  let joined = lines.join('\n\n')
  if (joined.length > maxChars) {
    // Keep the tail — recent turns are usually the most relevant for
    // distillation. The leading bytes get a "[truncated]" marker so the model
    // knows context was elided.
    joined = `[earlier turns truncated]\n\n${joined.slice(joined.length - maxChars)}`
  }

  const res = await provider.chat({
    model,
    messages: [
      { role: 'system', content: DISTILLER_SYSTEM_PROMPT },
      { role: 'user', content: `Transcript:\n\n${joined}` },
    ],
    temperature: cfg.temperature ?? 0.1,
    maxTokens: cfg.maxTokens ?? 1200,
  })

  const parsed = parseDistillerResponse(res.content)
  return {
    notes: parsed.notes,
    rawResponse: res.content,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    reparseUsed: parsed.reparseUsed,
  }
}

/**
 * Parse an LLM response into a list of DistilledNotes. Defensive against
 * common formatting variations: code fences, leading prose, trailing
 * commentary. Returns an empty array on any unrecoverable parse error.
 *
 * Exported for testing.
 */
export function parseDistillerResponse(raw: string): {
  notes: DistilledNote[]
  reparseUsed: boolean
} {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { notes: [], reparseUsed: false }

  // First attempt: parse as-is.
  const direct = tryParseArray(trimmed)
  if (direct.success) return { notes: direct.notes, reparseUsed: false }

  // Second attempt: strip common wrappers (code fences, leading prose).
  const stripped = stripWrappers(trimmed)
  if (stripped !== null) {
    const reparsed = tryParseArray(stripped)
    if (reparsed.success) return { notes: reparsed.notes, reparseUsed: true }
  }

  return { notes: [], reparseUsed: true }
}

function tryParseArray(text: string): { success: true; notes: DistilledNote[] } | { success: false } {
  try {
    const json = JSON.parse(text)
    const validated = DistilledArraySchema.safeParse(json)
    if (validated.success) return { success: true, notes: validated.data }
    // Maybe the model returned a single object instead of an array.
    const single = DistilledNoteSchema.safeParse(json)
    if (single.success) return { success: true, notes: [single.data] }
    return { success: false }
  } catch {
    return { success: false }
  }
}

function stripWrappers(text: string): string | null {
  // Strip ```json or ``` code fences (with or without language tag).
  const fenced = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()

  // Otherwise look for the first '[' and last ']' — the array body — and
  // hope what's between them parses. This rescues "Here are the facts:
  // [...]" style outputs.
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return text.slice(start, end + 1)

  return null
}

/**
 * Convert a list of distilled notes into markdown suitable for writing
 * to a draft wiki page. Frontmatter records what session produced them
 * so a reader can trace back.
 */
export function renderDistilledMarkdown(input: {
  sessionId: string
  sessionTitle: string | null
  notes: DistilledNote[]
  generatedAt: Date
}): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`name: distilled-${input.sessionId}`)
  lines.push(`status: draft`)
  lines.push(`source_session: ${input.sessionId}`)
  if (input.sessionTitle) lines.push(`source_session_title: ${JSON.stringify(input.sessionTitle)}`)
  lines.push(`generated_at: ${input.generatedAt.toISOString()}`)
  lines.push('---')
  lines.push('')
  lines.push(`# Distilled notes from session ${input.sessionTitle ?? input.sessionId}`)
  lines.push('')
  lines.push('These notes were extracted automatically. Review before promoting to canonical wiki pages.')
  lines.push('')

  const byKind = new Map<DistilledKind, DistilledNote[]>()
  for (const n of input.notes) {
    const arr = byKind.get(n.kind) ?? []
    arr.push(n)
    byKind.set(n.kind, arr)
  }
  const kindOrder: DistilledKind[] = ['preference', 'project', 'decision', 'definition', 'reference']
  for (const kind of kindOrder) {
    const notes = byKind.get(kind)
    if (!notes || notes.length === 0) continue
    lines.push(`## ${kind}`)
    lines.push('')
    for (const n of notes) {
      lines.push(`### ${n.title}`)
      lines.push('')
      lines.push(n.body)
      lines.push('')
    }
  }
  return lines.join('\n')
}
