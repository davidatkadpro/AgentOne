#!/usr/bin/env node
/**
 * End-to-end smoke for the auto-distill scheduler.
 *
 *   1. Create a session, plant 2 distinct facts via user messages.
 *   2. Stop sending; keep the WS open subscribed to the session.
 *   3. Wait for the scheduler's idle threshold to elapse + one scan cycle.
 *   4. Assert session.auto_distilled fires with notesCount > 0 and a draft
 *      path that exists on disk.
 *
 * Prereqs (TEMP):
 *   - researcher.yaml must include:
 *       auto_distill:
 *         enabled: true
 *         idle_minutes: 1
 *         scan_interval_minutes: 1
 *   - Server restarted with this config.
 *
 * The smoke does NOT touch the profile YAML — caller is responsible for
 * adding/removing the auto_distill block.
 *
 * Usage:
 *   node scripts/smoke-auto-distill.mjs [http://127.0.0.1:3737]
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

function waitForTurn(sessionId, { quietMs = 4_000, timeoutMs = 60_000 } = {}) {
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
      done(new Error(`timeout — collected ${collected.length} events`))
    }, timeoutMs)
  })
}

/** Wait for ANY of the given event types, or surface a useful diagnostic
 *  on timeout: lists every distinct event type that DID arrive, with a
 *  sample so we can tell whether the scheduler is running at all. */
function waitForAnyEvent(sessionId, eventTypes, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    const seenTypes = new Map() // type -> sample event
    let settled = false
    const done = (err, val) => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      ws.close()
      err ? reject(err) : resolve(val)
    }
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (!seenTypes.has(msg.type)) seenTypes.set(msg.type, msg)
        if (eventTypes.includes(msg.type)) done(null, msg)
      } catch { /* ignore */ }
    })
    ws.addEventListener('error', (e) => done(new Error(`ws error: ${e.message ?? e}`)))
    const overall = setTimeout(() => {
      const summary = [...seenTypes.entries()]
        .map(([t, ev]) => `${t} (${JSON.stringify(ev).slice(0, 120)}…)`)
        .join('\n      ')
      done(
        new Error(
          `timeout waiting for one of [${eventTypes.join(', ')}]. ` +
            `Events received during wait:\n      ${summary || '(none)'}`,
        ),
      )
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
  console.error(`Server not reachable at ${BASE}.`)
  process.exit(1)
}
console.log(`Server: ${JSON.stringify(health.body)}`)
const storageRoot = health.body.storageRoot
pass(`server up, agentProfile=${health.body.agentProfile}`)

let draftAbs = null
let cleanedUp = false
async function cleanup() {
  if (cleanedUp || !draftAbs) return
  cleanedUp = true
  try { await unlink(draftAbs) } catch { /* ignore */ }
}

try {
  console.log('\n[1] Create a session and plant 2 facts')
  const sessResp = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: health.body.agentProfile, title: 'smoke auto-distill' }),
  })
  if (!sessResp.ok || !sessResp.body.session?.id) {
    fail('create session', JSON.stringify(sessResp.body))
    process.exit(1)
  }
  const sessionId = sessResp.body.session.id
  pass(`created session ${sessionId}`)

  await sendMessage(
    sessionId,
    'Remember this preference: I want responses without trailing summaries.',
  )
  pass('turn 1 completed')
  await sendMessage(
    sessionId,
    'Project note: this repo is TypeScript ESM with Vitest, sqlite-vec embeddings.',
  )
  pass('turn 2 completed')

  console.log('\n[2] Wait for the scheduler to detect idle session (~70-130s with idle=1m, scan=1m)')
  console.log('    (idle threshold + one scan cycle in the worst-case phasing)')
  // Listen for BOTH success and skip so we get a useful diagnostic if the
  // scheduler decides not to distill (e.g. parse_failure, provider_error).
  const result = await waitForAnyEvent(
    sessionId,
    ['session.auto_distilled', 'session.auto_distill_skipped'],
    { timeoutMs: 180_000 },
  )
  if (result.type === 'session.auto_distill_skipped') {
    fail(`scheduler ran but skipped: reason="${result.reason}"`)
    console.log(`  full event: ${JSON.stringify(result)}`)
    process.exit(1)
  }
  const distillEvent = result
  pass(`session.auto_distilled fired (${distillEvent.notesCount} note${distillEvent.notesCount === 1 ? '' : 's'})`)
  console.log(`  draft path: ${distillEvent.draftPath}`)

  draftAbs = resolve(storageRoot, 'wiki', distillEvent.draftPath)
  try {
    const content = await readFile(draftAbs, 'utf-8')
    pass(`draft page exists on disk (${content.length} bytes)`)
    console.log('\n--- draft contents ---')
    console.log(content)
    console.log('--- end draft ---\n')
  } catch (err) {
    fail('draft page not on disk', err.message)
  }
} finally {
  await cleanup()
  console.log('--- cleanup: draft removed ---')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
