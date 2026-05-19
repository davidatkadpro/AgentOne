import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFolderAdapter } from '@/storage/local-folder.js'
import { createDatabase, type Db } from '@/storage/db.js'
import { WikiEngine } from '@/memory/wiki/engine.js'

interface Harness {
  root: string
  db: Db
  storage: LocalFolderAdapter
  wiki: WikiEngine
}

async function newHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agentone-wiki-'))
  const db = createDatabase({ path: ':memory:', skipMkdir: true })
  const storage = new LocalFolderAdapter({ root })
  const wiki = new WikiEngine({ storage, db, prefix: 'wiki' })
  await wiki.whenReady()
  return { root, db, storage, wiki }
}

async function disposeHarness(h: Harness): Promise<void> {
  h.db.close()
  await rm(h.root, { recursive: true, force: true })
}

describe('WikiEngine', () => {
  let h: Harness
  beforeEach(async () => {
    h = await newHarness()
  })
  afterEach(async () => {
    await disposeHarness(h)
  })

  it('write then read round-trips content and frontmatter', async () => {
    await h.wiki.write(
      'projects/agentone',
      '---\nname: Agentone Project\ntags: [active]\n---\n\n# Agentone\n\nFirst paragraph.',
    )
    const page = await h.wiki.read('projects/agentone')
    expect(page).not.toBeNull()
    expect(page!.path).toBe('projects/agentone')
    expect(page!.name).toBe('Agentone Project')
    expect(page!.frontmatter.tags).toEqual(['active'])
    expect(page!.body).toContain('# Agentone')
    expect(page!.body).toContain('First paragraph.')
  })

  it('read of a missing page returns null (not an exception)', async () => {
    expect(await h.wiki.read('not/there')).toBeNull()
  })

  it('accepts both with-suffix and without-suffix paths', async () => {
    await h.wiki.write('notes/idea.md', 'body')
    const a = await h.wiki.read('notes/idea')
    const b = await h.wiki.read('notes/idea.md')
    expect(a?.body).toBe('body')
    expect(b?.body).toBe('body')
    expect(a?.path).toBe(b?.path)
  })

  it('derives a name from the path when no frontmatter is present', async () => {
    await h.wiki.write('notes/some-idea', 'body')
    const page = await h.wiki.read('notes/some-idea')
    expect(page?.name).toBe('Some Idea')
  })

  it('append adds to the existing body without disturbing frontmatter', async () => {
    await h.wiki.write(
      'logs/today',
      '---\nname: Today\n---\n\nFirst entry.',
    )
    await h.wiki.append('logs/today', 'Second entry.')
    const page = await h.wiki.read('logs/today')
    expect(page?.frontmatter.name).toBe('Today')
    expect(page?.body).toBe('First entry.\n\nSecond entry.')
  })

  it('append creates the page when it does not exist yet', async () => {
    await h.wiki.append('new/page', 'Hello.')
    const page = await h.wiki.read('new/page')
    expect(page?.body).toBe('Hello.')
  })

  it('edit replaces a unique substring in the body but preserves the rest', async () => {
    await h.wiki.write(
      'projects/alpha',
      '# Alpha\n\nstatus: draft\n\nDetails go here.',
    )
    await h.wiki.edit('projects/alpha', 'status: draft', 'status: approved')
    const page = await h.wiki.read('projects/alpha')
    expect(page?.body).toContain('status: approved')
    expect(page?.body).toContain('Details go here.')
    expect(page?.body).not.toContain('status: draft')
  })

  it('edit throws PRECONDITION when the find-string is absent', async () => {
    await h.wiki.write('p', 'body')
    await expect(h.wiki.edit('p', 'missing-needle', 'X')).rejects.toMatchObject({
      code: 'PRECONDITION',
    })
  })

  it('edit throws PRECONDITION when the find-string occurs more than once', async () => {
    await h.wiki.write('p', 'pick me. pick me.')
    await expect(h.wiki.edit('p', 'pick me', 'no')).rejects.toMatchObject({
      code: 'PRECONDITION',
    })
  })

  it('edit throws NOT_FOUND when the page does not exist', async () => {
    await expect(h.wiki.edit('missing', 'a', 'b')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('resolves [[Name]] backlinks via the frontmatter name', async () => {
    await h.wiki.write(
      'people/alice',
      '---\nname: Alice Smith\n---\n\nLead engineer.',
    )
    await h.wiki.write(
      'projects/alpha',
      '# Alpha\n\nOwned by [[Alice Smith]].',
    )
    const links = await h.wiki.backlinks('people/alice')
    expect(links.length).toBe(1)
    expect(links[0]?.path).toBe('projects/alpha')
  })

  it('resolves [[path/to/page]] backlinks directly', async () => {
    await h.wiki.write('refs/x', 'target body')
    await h.wiki.write('notes/a', 'see [[refs/x]] for details')
    const links = await h.wiki.backlinks('refs/x')
    expect(links.length).toBe(1)
    expect(links[0]?.path).toBe('notes/a')
  })

  it('backlinks does not include [[file:...]] external references', async () => {
    await h.wiki.write('notes/intro', 'see [[file:projects/scope.pdf]]')
    const links = await h.wiki.backlinks('projects/scope.pdf')
    expect(links).toEqual([])
  })

  it('search finds pages by content terms', async () => {
    await h.wiki.write('notes/one', '---\nname: One\n---\n\nThe quick brown fox.')
    await h.wiki.write('notes/two', '---\nname: Two\n---\n\nA lazy dog sleeps.')
    const hits = await h.wiki.search('fox')
    expect(hits.length).toBe(1)
    expect(hits[0]?.path).toBe('notes/one')
  })

  it('search returns empty list for an empty query', async () => {
    await h.wiki.write('p', 'body')
    expect(await h.wiki.search('   ')).toEqual([])
  })

  it('search prefix filter restricts to a path subtree', async () => {
    await h.wiki.write('projects/alpha', 'shared word')
    await h.wiki.write('notes/x', 'shared word')
    const projHits = await h.wiki.search('shared', { prefix: 'projects/' })
    expect(projHits.map((h) => h.path)).toEqual(['projects/alpha'])
  })

  it('search honours limit and offset for pagination', async () => {
    await h.wiki.write('a', 'banana')
    await h.wiki.write('b', 'banana banana')
    await h.wiki.write('c', 'banana')
    const first = await h.wiki.search('banana', { limit: 2 })
    expect(first.length).toBe(2)
    const next = await h.wiki.search('banana', { limit: 2, offset: 2 })
    expect(next.length).toBe(1)
  })

  it('reindex picks up files written directly to disk (filesystem source of truth)', async () => {
    await h.storage.write('wiki/external.md', '---\nname: External\n---\n\nadded directly')
    await h.wiki.reindex()
    const page = await h.wiki.read('external')
    expect(page).not.toBeNull()
    expect(page?.name).toBe('External')

    const hits = await h.wiki.search('directly')
    expect(hits.length).toBe(1)
    expect(hits[0]?.path).toBe('external')
  })

  it('a second write deletes the old backlink and inserts the new one', async () => {
    await h.wiki.write('refs/x', 'x')
    await h.wiki.write('refs/y', 'y')
    await h.wiki.write('notes/n', 'see [[refs/x]]')
    expect((await h.wiki.backlinks('refs/x')).length).toBe(1)
    expect((await h.wiki.backlinks('refs/y')).length).toBe(0)

    await h.wiki.write('notes/n', 'see [[refs/y]]')
    expect((await h.wiki.backlinks('refs/x')).length).toBe(0)
    expect((await h.wiki.backlinks('refs/y')).length).toBe(1)
  })
})
