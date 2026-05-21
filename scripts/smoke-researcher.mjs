#!/usr/bin/env node
/**
 * End-to-end smoke for the researcher agent profile. Exercises:
 *   - M8: lazy-load experts/consult + real OpenRouter call via consult_expert
 *   - M9: lazy-load system/documents + read_document against a real PDF
 *
 * Prereqs:
 *   - Server running with AGENT_PROFILE=researcher and OPENROUTER_API_KEY set
 *   - LM Studio running with the local-fast model loaded
 *
 * Usage:
 *   node scripts/smoke-researcher.mjs [http://127.0.0.1:3737]
 *
 * Cost: one consult_expert call against claude-sonnet-4.6 — well under the
 * researcher profile's $0.50/call cap.
 */
import { writeFile, unlink, mkdir } from 'node:fs/promises'
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

/**
 * Subscribe to a session's events and resolve when the conversation has been
 * idle for `quietMs` after at least one `message.assistant.completed`. This
 * captures the FULL multi-iteration turn (model -> tool -> model -> ...) not
 * just the first iteration.
 */
function waitForTurn(sessionId, { quietMs = 5_000, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws`)
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

    ws.addEventListener('open', () => ws.send(JSON.stringify({ op: 'subscribe', sessionId })))
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        collected.push(msg)
        if (msg.type === 'message.assistant.completed') {
          sawCompletion = true
          armQuiet()
        } else if (sawCompletion) {
          // Any further activity (tool.called, delta, etc.) resets the quiet timer.
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

// A minimal valid PDF rendering "ProjectAlphaScopeDocument". Identical
// construction approach as the unit test fixture, but a distinctive
// content marker so we can verify the agent quoted from this exact file.
function minimalPdf(text) {
  const streamBuf = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1')
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${streamBuf.length} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefStart = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
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
  return events
    .filter((e) => e.type === 'message.assistant.delta')
    .map((e) => e.delta ?? '')
    .join('')
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
  console.error(
    `\nExpected agentProfile=researcher, got "${health.body.agentProfile}". ` +
      `Set AGENT_PROFILE=researcher in .env and restart.`,
  )
  process.exit(1)
}
pass(`server is up, agentProfile=researcher`)

const storageRoot = health.body.storageRoot
if (!storageRoot) {
  console.error('Server did not report storageRoot in /api/health')
  process.exit(1)
}

const fixtureRel = 'projects/agentone-smoke-fixture.pdf'
const fixtureAbs = resolve(storageRoot, fixtureRel.replace(/\//g, '/'))
const fixtureMarker = 'ProjectAlphaScopeDocument'

await mkdir(resolve(storageRoot, 'projects'), { recursive: true })
await writeFile(fixtureAbs, minimalPdf(fixtureMarker))
pass(`wrote fixture PDF to ${fixtureRel}`)

let cleanedUp = false
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { await unlink(fixtureAbs) } catch { /* ignore */ }
}
process.on('exit', () => { /* sync only */ })

try {
  // --- session 1: M9 read_document ---
  console.log('\n[1] M9: read a real PDF via system/documents')
  const sess1 = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: 'researcher', title: 'smoke M9' }),
  })
  if (!sess1.ok || !sess1.body.session?.id) { fail('create session 1', JSON.stringify(sess1.body)); throw new Error('session create failed') }
  const sessionId1 = sess1.body.session.id
  pass(`created session ${sessionId1}`)

  const events1 = await sendAndCollectReply(
    sessionId1,
    `Please read the file projects/agentone-smoke-fixture.pdf and tell me the exact text it contains. Use read_document; you may need to load_skill system/documents first.`,
  )
  const reply1 = joinDeltas(events1)
  console.log(`  reply: ${JSON.stringify(reply1.slice(0, 200))}`)

  const loadCalls = events1.filter((e) => e.type === 'skill.loaded' && e.name === 'system/documents')
  if (loadCalls.length > 0) pass('agent loaded system/documents')
  else fail('agent did not load system/documents', 'expected one skill.loaded for system/documents')

  const readCalls = toolCallsBy(events1, 'read_document')
  if (readCalls.length > 0) pass(`agent called read_document (${readCalls.length}x)`)
  else fail('agent did not call read_document')

  if (reply1.includes(fixtureMarker)) pass(`agent quoted the marker "${fixtureMarker}"`)
  else fail(`agent did not quote the marker "${fixtureMarker}"`, `reply was: "${reply1.slice(0, 200)}"`)

  // --- session 2: M8 consult_expert ---
  console.log('\n[2] M8: consult the OpenRouter expert via experts/consult')
  const sess2 = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: 'researcher', title: 'smoke M8' }),
  })
  if (!sess2.ok || !sess2.body.session?.id) { fail('create session 2', JSON.stringify(sess2.body)); throw new Error('session create failed') }
  const sessionId2 = sess2.body.session.id
  pass(`created session ${sessionId2}`)

  const events2 = await sendAndCollectReply(
    sessionId2,
    `Call load_skill with name="experts/consult". Then call consult_expert with expert="openrouter-claude-sonnet", question="What is 2+2? Just the number.", context="basic math". Do not narrate or summarise — only emit tool calls and the final answer.`,
  )
  const reply2 = joinDeltas(events2)
  console.log(`  full reply (${reply2.length} chars): ${JSON.stringify(reply2)}`)
  const allToolCalls = events2.filter((e) => e.type === 'tool.called').map((e) => e.tool)
  console.log(`  all tool.called names: [${allToolCalls.join(', ')}]`)

  const expertLoad = events2.filter((e) => e.type === 'skill.loaded' && e.name === 'experts/consult')
  if (expertLoad.length > 0) pass('agent loaded experts/consult')
  else fail('agent did not load experts/consult')

  const consultCalls = toolCallsBy(events2, 'consult_expert')
  if (consultCalls.length > 0) pass(`agent called consult_expert (${consultCalls.length}x)`)
  else fail('agent did not call consult_expert')

  const consultedEvents = events2.filter((e) => e.type === 'expert.consulted')
  if (consultedEvents.length > 0) {
    const total = consultedEvents.reduce((a, e) => a + (e.costUsd ?? 0), 0)
    pass(`expert.consulted fired (${consultedEvents.length}x); total cost $${total.toFixed(6)}`)
  } else {
    fail('no expert.consulted event observed')
  }

  if (/\b4\b/.test(reply2)) pass('agent surfaced the expert reply (matched "4")')
  else fail('agent did not surface the expert reply', `reply: "${reply2.slice(0, 200)}"`)

  // In-stream Hermes-XML hiding: the model emits <tool_call> XML, but the
  // provider's stream filter should suppress those deltas before they hit
  // the WS. The end-of-stream parser still promotes the block into a
  // native tool call (asserted above via tool.called + expert.consulted).
  if (!/<tool_call>|<function=|<\/tool_call>/.test(reply2)) {
    pass('streamed deltas contain no <tool_call> XML (in-stream filter working)')
  } else {
    fail(
      'streamed deltas leaked <tool_call> XML',
      `reply contained Hermes markup: "${reply2.slice(0, 300)}"`,
    )
  }
} finally {
  await cleanup()
  console.log('\n--- cleanup: fixture removed ---')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
