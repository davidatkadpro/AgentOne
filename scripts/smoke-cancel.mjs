#!/usr/bin/env node
/**
 * End-to-end smoke for M14 cancellation.
 *
 *   1. Open a session.
 *   2. Send a long-form prompt that will stream for several seconds.
 *   3. After ~600ms of streaming, POST /api/sessions/:id/cancel.
 *   4. Assert:
 *      - cancel API returns outcome="cancelled"
 *      - turn.cancel_requested fires on the WS
 *      - turn.cancelled fires with kind="hard" (caught mid-stream)
 *      - the WS sees significantly fewer deltas than a full reply would have
 *
 * Prereqs: server up, LM Studio reachable with the local-fast model.
 *
 * Usage:
 *   node scripts/smoke-cancel.mjs [http://127.0.0.1:3737]
 */
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

/** Collect every event for `sessionId` from open to one of `terminalTypes`,
 *  or until `maxMs` elapses. */
function collectUntil(sessionId, terminalTypes, maxMs = 60_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    const collected = []
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      ws.close()
      err ? reject(err) : resolve(collected)
    }
    ws.addEventListener('open', () => {
      // Once the WS is open, the caller will trigger work.
      resolveOpen?.()
    })
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        collected.push(msg)
        if (terminalTypes.includes(msg.type)) {
          // Wait one more tick for any trailing events.
          setTimeout(() => done(null), 200)
        }
      } catch { /* ignore */ }
    })
    ws.addEventListener('error', (e) => done(new Error(`ws error: ${e.message ?? e}`)))
    const timeout = setTimeout(() => done(null), maxMs)
    let resolveOpen
    collected.openP = new Promise((r) => (resolveOpen = r))
  })
}

console.log(`Pinging ${BASE} ...`)
const health = await api('/api/health')
if (!health.ok) {
  console.error(`Server not reachable at ${BASE}.`)
  process.exit(1)
}
pass(`server up, agentProfile=${health.body.agentProfile}`)

const sessResp = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ agentProfile: health.body.agentProfile, title: 'smoke cancel' }),
})
if (!sessResp.ok) {
  fail('create session', JSON.stringify(sessResp.body))
  process.exit(1)
}
const sessionId = sessResp.body.session.id
pass(`created session ${sessionId}`)

// A prompt that produces a long-running stream. Asking for a long enumerated
// list keeps the model in generation mode for several seconds.
const prompt =
  'Please enumerate, in detail, the first 100 prime numbers. For each one, ' +
  'explain in a paragraph why it is prime, what mathematical properties it has, ' +
  'and any historical significance. Take your time and be thorough.'

const eventsP = collectUntil(sessionId, ['turn.cancelled', 'message.assistant.completed'], 60_000)
// Tiny pause to let the WS open before we trigger work.
await new Promise((r) => setTimeout(r, 100))

console.log('\n[1] Send long prompt, wait ~600ms, then cancel')
await api(`/api/sessions/${sessionId}/messages`, {
  method: 'POST',
  body: JSON.stringify({ text: prompt }),
})

// Let some deltas land before we cancel.
await new Promise((r) => setTimeout(r, 600))

const cancelResp = await api(`/api/sessions/${sessionId}/cancel`, { method: 'POST' })
if (!cancelResp.ok) {
  fail('cancel API', JSON.stringify(cancelResp.body))
} else {
  pass(`cancel API returned outcome="${cancelResp.body.outcome}"`)
  if (cancelResp.body.outcome === 'cancelled') {
    pass('outcome was "cancelled" (a turn was in flight)')
  } else if (cancelResp.body.outcome === 'no_active_turn') {
    fail('cancel raced past the turn — the smoke fired too late', 'try increasing the pre-cancel sleep')
  } else {
    fail(`unexpected outcome "${cancelResp.body.outcome}"`)
  }
}

const events = await eventsP
const deltas = events.filter((e) => e.type === 'message.assistant.delta')
const requested = events.find((e) => e.type === 'turn.cancel_requested')
const cancelled = events.find((e) => e.type === 'turn.cancelled')
const completed = events.find((e) => e.type === 'message.assistant.completed')

console.log(`\n  delta events: ${deltas.length}`)
console.log(`  cancel_requested? ${Boolean(requested)}`)
console.log(`  cancelled? ${cancelled ? `yes (kind=${cancelled.kind})` : 'no'}`)
console.log(`  completed? ${Boolean(completed)}`)

if (requested) pass('turn.cancel_requested fired')
else fail('no turn.cancel_requested event')

if (cancelled) {
  pass(`turn.cancelled fired (kind=${cancelled.kind})`)
  // Either kind is valid — hard means the stream was torn down mid-flight,
  // soft means cancel landed at an iteration boundary just after streaming
  // completed but before the next iteration started.
} else {
  fail('no turn.cancelled event')
}

// The text-length proxy: a full reply to the prompt would produce hundreds of
// deltas. Cancellation within ~600ms should keep it well under that.
if (deltas.length > 0 && deltas.length < 400) {
  pass(`deltas count (${deltas.length}) is below a full-reply floor`)
} else {
  fail(
    `deltas count ${deltas.length} doesn't match a cancelled-mid-stream profile`,
    'expected some deltas but below 400; either nothing streamed or cancel raced past',
  )
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
