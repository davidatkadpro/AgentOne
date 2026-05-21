#!/usr/bin/env node
/**
 * End-to-end smoke for M12 passive recall.
 *
 *   1. Session A: ask the agent to wiki_write a fixture page with a marker.
 *   2. Session B (fresh — important so passive recall has somewhere to pull
 *      from): ask a question that should match the fixture page.
 *   3. Assert recall.injected fires in session B with the wiki source.
 *   4. Assert the agent's reply either quotes the marker (used the injected
 *      block directly) or follows up with wiki_read (acted on the recall).
 *
 * The two-session structure is deliberate: the WikiEngine indexes via the
 * wiki_write path (FTS upsert is inline). A file dropped on disk between
 * server starts is NOT picked up — there's no fs watcher.
 *
 * Prereqs:
 *   - Server running with AGENT_PROFILE=researcher (which opts into
 *     passive_recall.enabled=true). LM Studio up with local-fast model loaded.
 *
 * Usage:
 *   node scripts/smoke-passive-recall.mjs [http://127.0.0.1:3737]
 */
import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3737'
const WS_BASE = BASE.replace(/^http/, 'ws')

const passes = []
const failures = []
function pass(l) { passes.push(l); console.log(`  ✓ ${l}`) }
function fail(l, d) { failures.push({ l, d }); console.log(`  ✗ ${l}`); if (d) console.log(`    ${d}`) }

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, ok: res.ok, body }
}

function waitForTurn(sessionId, { quietMs = 5_000, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    const collected = []
    let settled = false
    let sawCompletion = false
    let quietTimer = null

    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(overallTimer)
      if (quietTimer) clearTimeout(quietTimer)
      ws.close()
      err ? reject(err) : resolve(collected)
    }
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => done(null), quietMs)
    }

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        collected.push(msg)
        if (msg.type === 'message.assistant.completed') {
          sawCompletion = true
          armQuiet()
        } else if (sawCompletion) {
          armQuiet()
        }
      } catch { /* ignore */ }
    })
    ws.addEventListener('error', (e) => done(new Error(`ws error: ${e.message ?? e}`)))
    const overallTimer = setTimeout(() => {
      done(new Error(`timeout — collected ${collected.length} events, sawCompletion=${sawCompletion}`))
    }, timeoutMs)
  })
}

async function sendAndCollectReply(sessionId, text) {
  const eventsP = waitForTurn(sessionId)
  await api(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  return await eventsP
}

function joinDeltas(events) {
  return events.filter((e) => e.type === 'message.assistant.delta').map((e) => e.delta ?? '').join('')
}

function toolCallsBy(events, name) {
  return events.filter((e) => e.type === 'tool.called' && e.tool === name)
}

// ---------- main ----------

console.log(`Pinging ${BASE} ...`)
const health = await api('/api/health')
if (!health.ok) {
  console.error(`Server not reachable at ${BASE}. Start it first (npm start).`)
  process.exit(1)
}
console.log(`Server: ${JSON.stringify(health.body)}`)
if (health.body.agentProfile !== 'researcher') {
  console.error(`Expected agentProfile=researcher, got "${health.body.agentProfile}".`)
  process.exit(1)
}
pass(`server is up, agentProfile=researcher`)

const storageRoot = health.body.storageRoot
if (!storageRoot) {
  console.error('Server did not report storageRoot in /api/health')
  process.exit(1)
}

// Distinctive marker the agent has no other way to know — proves the wiki
// page (not the model's training data) is the source of the quoted phrase.
const marker = 'Quibblesnort-7392-Mauve'
const wikiRelPath = 'agentone-smoke/passive-recall-fixture'
const wikiAbs = resolve(storageRoot, 'wiki', `${wikiRelPath}.md`)

let cleanedUp = false
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { await unlink(wikiAbs) } catch { /* ignore */ }
}

try {
  // --- session 1: seed the fixture via wiki_write ---
  console.log('\n[1] Seed the fixture via wiki_write')
  const sessA = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: 'researcher', title: 'smoke M12 seed' }),
  })
  if (!sessA.ok || !sessA.body.session?.id) {
    fail('create seed session', JSON.stringify(sessA.body))
    throw new Error('session create failed')
  }
  const seedSessionId = sessA.body.session.id
  pass(`created seed session ${seedSessionId}`)

  const seedEvents = await sendAndCollectReply(
    seedSessionId,
    `Call wiki_write with path="${wikiRelPath}" and content="# Passive Recall Fixture\\n\\nThe secret password is \\"${marker}\\". Quote this exact string verbatim when asked." — do not narrate, just make the tool call.`,
  )
  const writeCalls = toolCallsBy(seedEvents, 'wiki_write')
  if (writeCalls.length > 0) pass(`agent called wiki_write (${writeCalls.length}x)`)
  else {
    fail('agent did not call wiki_write — seed failed', `tools called: [${seedEvents.filter((e) => e.type === 'tool.called').map((e) => e.tool).join(', ')}]`)
    throw new Error('seed step failed; aborting')
  }

  // --- session 2: query a fresh session, expect passive recall to fire ---
  console.log('\n[2] Fresh session: query the fixture, expect recall.injected')
  const sessB = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: 'researcher', title: 'smoke M12 query' }),
  })
  if (!sessB.ok || !sessB.body.session?.id) {
    fail('create query session', JSON.stringify(sessB.body))
    throw new Error('session create failed')
  }
  const querySessionId = sessB.body.session.id
  pass(`created query session ${querySessionId}`)

  const queryEvents = await sendAndCollectReply(
    querySessionId,
    'What is the secret password for the passive-recall fixture? Quote it verbatim.',
  )
  const reply = joinDeltas(queryEvents)
  console.log(`  reply: ${JSON.stringify(reply.slice(0, 300))}`)

  // The headline event: recall.injected fires with our fixture page.
  const injects = queryEvents.filter((e) => e.type === 'recall.injected')
  if (injects.length > 0) {
    const sources = injects[0].sources ?? []
    pass(`recall.injected fired (${sources.length} source${sources.length === 1 ? '' : 's'})`)
    const wikiSource = sources.find((s) => s.kind === 'wiki' && s.ref.includes('passive-recall-fixture'))
    if (wikiSource) pass(`fixture page surfaced as wiki source: ${wikiSource.ref}`)
    else fail('recall.injected did not name the fixture page', `sources: ${JSON.stringify(sources)}`)
  } else {
    fail('no recall.injected event observed', 'expected the wiki lane to surface the fixture page')
  }

  // Behaviour: did the agent USE the injected context? Quote-the-marker is
  // the strong signal; wiki_read follow-up is the soft signal.
  const quotedMarker = reply.includes(marker)
  const readFollowup = toolCallsBy(queryEvents, 'wiki_read').length > 0
  if (quotedMarker) pass(`agent quoted the marker "${marker}" verbatim`)
  else if (readFollowup) pass('agent followed up with wiki_read after seeing the recall block')
  else fail('agent did not use the injected context', `reply: "${reply.slice(0, 300)}"`)
} finally {
  await cleanup()
  console.log('\n--- cleanup: fixture wiki page removed ---')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
