import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import yaml from 'js-yaml'
import type { ModelProfile } from '../core/types.js'

const Schema = z.object({
  id: z.string().min(1),
  provider: z.enum(['lmstudio', 'openrouter']),
  model: z.string().min(1),
  role: z.enum(['general', 'compressor', 'embedding', 'expert']),
  context_window: z.number().int().positive(),
  params: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().optional(),
      top_p: z.number().min(0).max(1).optional(),
    })
    .default({}),
})

function fromYaml(raw: unknown): ModelProfile {
  const parsed = Schema.parse(raw)
  return {
    id: parsed.id,
    provider: parsed.provider,
    model: parsed.model,
    role: parsed.role,
    contextWindow: parsed.context_window,
    params: {
      ...(parsed.params.temperature !== undefined && { temperature: parsed.params.temperature }),
      ...(parsed.params.max_tokens !== undefined && { maxTokens: parsed.params.max_tokens }),
      ...(parsed.params.top_p !== undefined && { topP: parsed.params.top_p }),
    },
  }
}

export async function loadModelProfile(filePath: string): Promise<ModelProfile> {
  const text = await readFile(filePath, 'utf-8')
  return fromYaml(yaml.load(text))
}

export async function loadModelProfiles(dir: string): Promise<Map<string, ModelProfile>> {
  const entries = await readdir(dir)
  const files = entries.filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'))
  const profiles = await Promise.all(files.map((f) => loadModelProfile(join(dir, f))))
  const map = new Map<string, ModelProfile>()
  for (const profile of profiles) {
    if (map.has(profile.id)) {
      throw new Error(`Duplicate Model Profile id "${profile.id}" in ${dir}`)
    }
    map.set(profile.id, profile)
  }
  return map
}
