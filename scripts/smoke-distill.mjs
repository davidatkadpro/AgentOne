#!/usr/bin/env node
/**
 * End-to-end smoke for M13 /distill.
 *
 *   1. Create a session.
 *   2. Plant 3 distinct facts via user messages (preference, project, decision).
 *   3. Issue /distill via the command endpoint.
 *   4. Assert the response text reports notes written + a drafts path.
 *   5. Read the draft markdown off disk and print so we can eyeball the
 *      compressor model's actual output quality.
 *
 * Prereqs:
 *   - Server running with AGENT_PROFILE=researcher (any profile works as
 *     long as it has a compressor_model configured). LM Studio up with the
 *     local-fast model loaded.
 *
 * Usage:
 *   node scripts/smoke-distill.mjs [http://127.0.0.1:3737]
 */
import { readFile, unlink } from 'node:fs/promises'
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

async function sendMessage(sessionId, text) {
  const eventsP = waitForTurn(sessionId)
  await api(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
  return await eventsP
}

// ---------- main ----------

console.log(`Pinging ${BASE} ...`)
const health = await api('/api/health')
if (!health.ok) {
  console.error(`Server not reachable at ${BASE}. Start it first (npm start).`)
  process.exit(1)
}
console.log(`Server: ${JSON.stringify(health.body)}`)
const storageRoot = health.body.storageRoot
if (!storageRoot) {
  console.error('Server did not report storageRoot in /api/health')
  process.exit(1)
}
pass(`server is up, agentProfile=${health.body.agentProfile}`)

let draftAbs = null
let cleanedUp = false
async function cleanup() {
  if (cleanedUp || !draftAbs) return
  cleanedUp = true
  try { await unlink(draftAbs) } catch { /* ignore */ }
}

try {
  console.log('\n[1] Create a session and plant three distinct facts')
  const sessResp = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: health.body.agentProfile, title: 'smoke M13' }),
  })
  if (!sessResp.ok || !sessResp.body.session?.id) {
    fail('create session', JSON.stringify(sessResp.body))
    process.exit(1)
  }
  const sessionId = sessResp.body.session.id
  pass(`created session ${sessionId}`)

  // Three explicit facts of different kinds. Phrased so even a small local
  // model can categorise them reliably.
  const facts = [
    'I want you to remember a preference: I prefer concise responses with no trailing summaries.',
    'A factual project note: this codebase is built in TypeScript ESM with Vitest for tests.',
    'A decision I made: I chose OpenRouter as the expert provider over direct Anthropic because budget control matters more than direct billing.',
  ]
  for (let i = 0; i < facts.length; i++) {
    await sendMessage(sessionId, facts[i])
    pass(`turn ${i + 1} completed`)
  }

  console.log('\n[2] Run /distill')
  const distillResp = await api(`/api/sessions/${sessionId}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'distill' }),
  })
  if (!distillResp.ok) {
    fail('/distill HTTP', `status=${distillResp.status} body=${JSON.stringify(distillResp.body)}`)
    process.exit(1)
  }
  const result = distillResp.body.result
  console.log(`  result kind: ${result?.kind}`)
  console.log(`  result content:\n${(result?.content ?? '').split('\n').map((l) => '    ' + l).join('\n')}`)

  if (result?.kind === 'text' && /Distilled \d+ note/.test(result.content)) {
    pass('result reported notes written')
  } else if (result?.kind === 'text' && /No durable facts/.test(result.content)) {
    fail('distiller returned zero notes', 'compressor model produced no extractable JSON')
  } else if (result?.kind === 'text' && /non-JSON/.test(result.content)) {
    fail('distiller could not parse model output', `content: ${result.content}`)
  } else if (result?.kind === 'error') {
    fail('/distill returned error', result.message)
  } else {
    fail('unexpected /distill response', JSON.stringify(result))
  }

  // Extract the draft path from the result text. Format: "to wiki/drafts/distilled-<id>-<date>.md"
  const match = (result?.content ?? '').match(/wiki\/(drafts\/distilled-[\w-]+\.md)/)
  if (match) {
    const draftRel = match[1]
    draftAbs = resolve(storageRoot, 'wiki', draftRel)
    try {
      const content = await readFile(draftAbs, 'utf-8')
      pass(`draft page exists on disk (${content.length} bytes)`)
      console.log('\n--- draft page contents ---')
      console.log(content)
      console.log('--- end draft ---\n')

      // Soft-check: did the model identify any of the categories we planted?
      const sawPreference = /## preference/.test(content)
      const sawProject = /## project/.test(content)
      const sawDecision = /## decision/.test(content)
      const categoriesSurfaced = [sawPreference && 'preference', sawProject && 'project', sawDecision && 'decision'].filter(Boolean)
      if (categoriesSurfaced.length >= 2) {
        pass(`model categorised at least 2/3 planted facts (${categoriesSurfaced.join(', ')})`)
      } else {
        fail(`model categorised only ${categoriesSurfaced.length}/3 planted facts`, `saw: ${categoriesSurfaced.join(', ') || 'none'}`)
      }
    } catch (err) {
      fail('draft page not on disk', err.message)
    }
  } else if (result?.kind === 'text' && /Distilled/.test(result.content)) {
    fail('could not parse draft path out of distill response', `content: ${result.content}`)
  }
} finally {
  await cleanup()
  console.log('--- cleanup: draft removed ---')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
