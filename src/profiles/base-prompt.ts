import { readFile } from 'node:fs/promises'

export async function loadBasePrompt(path: string): Promise<string> {
  const text = await readFile(path, 'utf-8')
  return text.trim()
}
