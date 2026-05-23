import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaildirEmailSource } from '../modules/email/src/sources/maildir.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentone-maildir-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeEml(name: string, contents: string): Promise<void> {
  await writeFile(join(root, name), contents)
}

describe('MaildirEmailSource', () => {
  it('lists empty when the directory is empty', async () => {
    const src = new MaildirEmailSource({ root })
    expect(await src.list()).toEqual([])
  })

  it('parses From / Subject / Date headers from a simple plain .eml', async () => {
    await writeEml(
      '001.eml',
      [
        'From: Riverside Owner <owner@example.com>',
        'To: ops@knowles.com',
        'Subject: RFI: bathroom fixtures',
        'Date: Fri, 23 May 2025 10:00:00 +0000',
        'Message-ID: <abc123@example.com>',
        '',
        'Hi — quick question about the proposed fixture set.',
        'Can we swap to brushed brass?',
      ].join('\n'),
    )

    const src = new MaildirEmailSource({ root })
    const list = await src.list()
    expect(list).toHaveLength(1)
    expect(list[0].sourceId).toBe('001.eml')
    expect(list[0].fromAddress).toBe('owner@example.com')
    expect(list[0].fromName).toBe('Riverside Owner')
    expect(list[0].subject).toBe('RFI: bathroom fixtures')
    expect(list[0].receivedAt).toBe(Date.parse('2025-05-23T10:00:00Z'))
    expect(list[0].snippet).toContain('Hi —')
  })

  it('returns the body via get()', async () => {
    await writeEml(
      '002.eml',
      ['From: a@b.com', 'Subject: hi', 'Date: Fri, 23 May 2025 10:00:00 +0000', '', 'body text'].join(
        '\n',
      ),
    )
    const src = new MaildirEmailSource({ root })
    const msg = await src.get('002.eml')
    expect(msg.body).toBe('body text')
  })

  it('handles missing From by falling back to empty address (no crash)', async () => {
    await writeEml(
      '003.eml',
      ['Subject: noname', 'Date: Fri, 23 May 2025 10:00:00 +0000', '', 'body'].join('\n'),
    )
    const src = new MaildirEmailSource({ root })
    const list = await src.list()
    expect(list).toHaveLength(1)
    expect(list[0].fromAddress).toBe('')
  })

  it('falls back to file mtime when no Date header is present', async () => {
    await writeEml('004.eml', ['From: a@b.com', 'Subject: undated', '', 'body'].join('\n'))
    const src = new MaildirEmailSource({ root })
    const list = await src.list()
    expect(list).toHaveLength(1)
    expect(list[0].receivedAt).toBeGreaterThan(0)
  })

  it('ignores non-.eml files', async () => {
    await writeEml('not-an-email.txt', 'hello')
    await mkdir(join(root, 'subdir'), { recursive: true })
    const src = new MaildirEmailSource({ root })
    expect(await src.list()).toEqual([])
  })

  it('getBody returns kind:text + content for plain emails (with quoted-printable decode)', async () => {
    await writeEml(
      '005.eml',
      [
        'From: a@b.com',
        'Subject: qp',
        'Date: Tue, 23 May 2026 10:00:00 +0000',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'caf=C3=A9 caf=C3=A9',
      ].join('\n'),
    )
    const src = new MaildirEmailSource({ root })
    const body = await src.getBody!('005.eml')
    expect(body.kind).toBe('text')
    expect(body.content).toContain('café')
  })

  it('getBody returns kind:html + sanitised content for text/html emails', async () => {
    await writeEml(
      '006.eml',
      [
        'From: a@b.com',
        'Subject: html',
        'Date: Tue, 23 May 2026 10:00:00 +0000',
        'Content-Type: text/html; charset=UTF-8',
        '',
        '<p>hi</p><script>alert(1)</script>',
      ].join('\n'),
    )
    const src = new MaildirEmailSource({ root })
    const body = await src.getBody!('006.eml')
    expect(body.kind).toBe('html')
    expect(body.content).toContain('<p>hi</p>')
    expect(body.content).not.toContain('script')
  })

  it('watch() returns a no-op unsubscribe when the dir does not exist', () => {
    // Using a never-created subpath — node:fs.watch on Windows throws ENOENT
    // immediately, on Linux it can succeed silently. Either way our wrapper
    // must always return a callable.
    const src = new MaildirEmailSource({ root: join(root, 'never') })
    const unsub = src.watch!(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('rejects path traversal in get() / getBody()', async () => {
    const src = new MaildirEmailSource({ root })
    await expect(src.get('../etc/passwd')).rejects.toThrow(/Invalid sourceId/)
    await expect(src.get('a/b.eml')).rejects.toThrow(/Invalid sourceId/)
  })
})

