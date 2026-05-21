#!/usr/bin/env node
/**
 * End-to-end smoke for the M10 deny_tools extension.
 *
 *   - Creates a fresh session under whichever profile the server runs.
 *   - Asks the agent to call wiki_write explicitly.
 *   - Asserts a `tool.hook_denied` event fired with the profile-deny hook.
 *   - Asserts the matching `tool.failed` event reports PERMISSION_DENIED
 *     and the reason names the matching pattern + profile.
 *
 * Prereqs:
 *   - Server running with a profile that includes:
 *
 *       deny_tools:
 *         - wiki_write
 *
 *   - LM Studio up with the local-fast model loaded.
 *
 * Usage:
 *   node scripts/smoke-deny-tools.mjs [http://127.0.0.1:3737]
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

function waitForTurn(sessionId, { quietMs = 5_000, timeoutMs = 90_000 } = {}) {
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

console.log(`Pinging ${BASE} ...`)
const health = await api('/api/health')
if (!health.ok) {
  console.error(`Server not reachable at ${BASE}. Start it first (npm start).`)
  process.exit(1)
}
console.log(`Server: ${JSON.stringify(health.body)}`)
pass(`server is up, agentProfile=${health.body.agentProfile}`)

console.log('\n[1] Create a session and ask the agent to call wiki_write (which should be denied)')
const sessResp = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ agentProfile: health.body.agentProfile, title: 'smoke deny_tools' }),
})
if (!sessResp.ok || !sessResp.body.session?.id) {
  fail('create session', JSON.stringify(sessResp.body))
  process.exit(1)
}
const sessionId = sessResp.body.session.id
pass(`created session ${sessionId}`)

const events = await sendMessage(
  sessionId,
  `Call wiki_write directly with path="smoke-deny-fixture" and content="should-not-land". Make the tool call; do not narrate. If the call fails, just report the failure verbatim.`,
)

const writeAttempts = events.filter((e) => e.type === 'tool.called' && e.tool === 'wiki_write')
if (writeAttempts.length > 0) {
  pass(`agent attempted wiki_write (${writeAttempts.length}x)`)
} else {
  fail('agent did not attempt wiki_write at all', `tools called: [${events.filter((e) => e.type === 'tool.called').map((e) => e.tool).join(', ')}]`)
}

const hookDenials = events.filter((e) => e.type === 'tool.hook_denied' && e.tool === 'wiki_write')
if (hookDenials.length > 0) {
  pass(`tool.hook_denied fired for wiki_write (hook="${hookDenials[0].hook}")`)
  if (hookDenials[0].hook === 'profile-deny-tools') {
    pass('denial came from the profile-deny-tools hook (not some other deny mechanism)')
  } else {
    fail('denial came from a different hook', `expected "profile-deny-tools", got "${hookDenials[0].hook}"`)
  }
  const reason = hookDenials[0].reason
  if (/wiki_write/.test(reason) && /\bdeny_tools\b|wiki_write/.test(reason)) {
    pass(`deny reason names the offending tool: "${reason}"`)
  } else {
    fail('deny reason was vague', `reason: "${reason}"`)
  }
} else {
  fail('no tool.hook_denied event for wiki_write', 'either deny_tools is not set in the profile or the wiring is broken')
}

const failedCalls = events.filter((e) => e.type === 'tool.failed' && e.tool === 'wiki_write')
if (failedCalls.length > 0) {
  pass(`tool.failed fired with code "${failedCalls[0].code}"`)
  if (failedCalls[0].code === 'PERMISSION_DENIED') {
    pass('tool.failed code is PERMISSION_DENIED (the expected mapping)')
  } else {
    fail('wrong tool.failed code', `expected PERMISSION_DENIED, got ${failedCalls[0].code}`)
  }
} else {
  fail('no tool.failed event for wiki_write')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
