import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listAvailableProfiles,
  listDrafts,
  parseDraft,
} from '@/server/profiles-and-drafts.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentone-pad-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function plant(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf-8')
}

describe('listAvailableProfiles', () => {
  it('returns an empty list when the directory is missing', async () => {
    expect(await listAvailableProfiles(join(dir, 'nope'))).toEqual([])
  })

  it('lists each *.yaml as a resolved profile', async () => {
    await plant(
      'profiles/_base.yaml',
      `id: _base\ndefault_model: local-fast\ndefault_skills:\n  - system/filesystem\n`,
    )
    await plant(
      'profiles/researcher.yaml',
      `id: researcher\nextends: _base\ndescription: research agent\n`,
    )
    const list = await listAvailableProfiles(join(dir, 'profiles'))
    const ids = list.map((p) => p.id)
    expect(ids).toEqual(['_base', 'researcher']) // _base first by convention
    const researcher = list.find((p) => p.id === 'researcher')!
    expect(researcher.ok).toBe(true)
    expect(researcher.description).toBe('research agent')
    expect(researcher.defaultModel).toBe('local-fast') // inherited from _base
    expect(researcher.defaultSkills).toEqual(['system/filesystem']) // inherited
  })

  it('surfaces broken profiles with ok=false rather than dropping them', async () => {
    await plant('profiles/broken.yaml', `id: broken\nnot_valid: ::\n`)
    const list = await listAvailableProfiles(join(dir, 'profiles'))
    const broken = list.find((p) => p.id === 'broken')!
    expect(broken.ok).toBe(false)
    expect(broken.error).toBeTruthy()
  })

  it('ignores non-yaml files', async () => {
    await plant('profiles/_base.yaml', `id: _base\ndefault_model: m\n`)
    await plant('profiles/README.md', '# not a profile')
    const list = await listAvailableProfiles(join(dir, 'profiles'))
    expect(list.map((p) => p.id)).toEqual(['_base'])
  })
})

describe('parseDraft', () => {
  it('extracts session id, timestamp, and note count from a typical draft', () => {
    const content = `---
name: distilled-sess-abc
status: draft
source_session: sess-abc-123
source_session_title: "My Session"
generated_at: 2026-05-22T12:00:00Z
---

# Distilled notes from session My Session

## preference

### Likes terse responses

User wants short answers.

### No emoji

Avoid emoji in output.

## project

### Storage on OneDrive

The repo's storage root is a OneDrive path.
`
    const parsed = parseDraft('distilled-sess-abc-2026-05-22.md', content)
    expect(parsed.sessionId).toBe('sess-abc-123')
    // js-yaml parses ISO dates → Date → .toISOString() adds .000Z; either
    // representation is correct, but the parsed form normalises to the
    // milliseconds-included variant.
    expect(parsed.generatedAt).toBe('2026-05-22T12:00:00.000Z')
    expect(parsed.title).toBe('distilled-sess-abc')
    expect(parsed.noteCount).toBe(3) // three ### entries
  })

  it('falls back to filename stem when frontmatter has no name', () => {
    const parsed = parseDraft('some-file.md', 'no frontmatter\n')
    expect(parsed.title).toBe('some-file')
    expect(parsed.sessionId).toBeNull()
    expect(parsed.generatedAt).toBeNull()
    expect(parsed.noteCount).toBe(0)
  })

  it('tolerates malformed frontmatter without throwing', () => {
    const parsed = parseDraft('weird.md', '---\nnot: valid: yaml: here:::\n---\nbody\n')
    expect(parsed.sessionId).toBeNull()
  })
})

describe('listDrafts', () => {
  it('returns an empty list when the drafts directory does not exist', async () => {
    expect(await listDrafts(dir)).toEqual([])
  })

  it('lists every *.md draft under wiki/drafts, newest-first', async () => {
    await plant(
      'wiki/drafts/older.md',
      `---\nsource_session: s1\ngenerated_at: 2026-05-20T00:00:00Z\n---\n\n### note\n`,
    )
    // Sleep briefly so the second file has a clearly-later mtime.
    await new Promise((r) => setTimeout(r, 30))
    await plant(
      'wiki/drafts/newer.md',
      `---\nsource_session: s2\ngenerated_at: 2026-05-22T00:00:00Z\n---\n\n### a\n\n### b\n`,
    )
    const drafts = await listDrafts(dir)
    expect(drafts).toHaveLength(2)
    // Newest first.
    expect(drafts[0].path).toBe('drafts/newer.md')
    expect(drafts[0].sessionId).toBe('s2')
    expect(drafts[0].noteCount).toBe(2)
    expect(drafts[1].path).toBe('drafts/older.md')
    expect(drafts[1].sessionId).toBe('s1')
    expect(drafts[1].noteCount).toBe(1)
  })

  it('ignores non-markdown files in the drafts directory', async () => {
    await plant('wiki/drafts/real.md', '### a\n')
    await plant('wiki/drafts/notes.txt', 'ignored')
    const drafts = await listDrafts(dir)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].path).toBe('drafts/real.md')
  })
})
