#!/usr/bin/env node
/**
 * End-to-end smoke against a running AgentOne server (with LM Studio behind it).
 *
 * Usage:
 *   1. Start the server in another terminal: npm start
 *   2. node scripts/smoke.mjs [http://127.0.0.1:3737]
 *
 * What it exercises:
 *   - GET  /api/health
 *   - GET  /api/commands
 *   - POST /api/sessions (create)
 *   - WS   /ws subscribe + event collection during a real chat turn
 *   - POST /api/sessions/:id/messages (real user message → real LM Studio reply)
 *   - POST /api/sessions/:id/command for /help, /sessions, /compact, /load, /clear
 *   - Cross-session memory via the search_history tool path (creates two sessions)
 *
 * Exits 0 if every assertion passes, 1 otherwise. Logs collected events.
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3737'
const WS_BASE = BASE.replace(/^http/, 'ws')

const passes = []
const failures = []

function pass(label) {
  passes.push(label)
  console.log(`  ✓ ${label}`)
}
function fail(label, detail) {
  failures.push({ label, detail })
  console.log(`  ✗ ${label}`)
  if (detail) console.log(`    ${detail}`)
}

async function api(path, opts = {}) {
  const url = `${BASE}${path}`
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body }
}

function waitForEvents(sessionId, types, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws`)
    const collected = []
    const remaining = new Set(types)
    let settled = false

    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      err ? reject(err) : resolve(collected)
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', sessionId }))
    })
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        collected.push(msg)
        if (remaining.has(msg.type)) {
          remaining.delete(msg.type)
          if (remaining.size === 0) done(null)
        }
      } catch {
        /* ignore non-json */
      }
    })
    ws.addEventListener('error', (e) => done(new Error(`WS error: ${e.message ?? e}`)))
    const timer = setTimeout(
      () => done(new Error(`Timeout waiting for events: ${[...remaining].join(', ')}`)),
      timeoutMs,
    )
  })
}

async function main() {
  console.log(`AgentOne smoke against ${BASE}`)

  // 1. health
  console.log('\n[1] /api/health')
  const health = await api('/api/health')
  if (health.ok && health.body.status === 'ok') {
    pass(`server up — model=${health.body.model} agent=${health.body.agentProfile}`)
  } else {
    fail('health check', JSON.stringify(health.body))
    return
  }

  // 2. command list
  console.log('\n[2] /api/commands')
  const cmds = await api('/api/commands')
  if (cmds.ok && Array.isArray(cmds.body.commands)) {
    const names = cmds.body.commands.map((c) => c.name)
    const expected = ['clear', 'compact', 'help', 'load', 'new', 'sessions']
    const missing = expected.filter((n) => !names.includes(n))
    if (missing.length === 0) {
      pass(`got ${cmds.body.commands.length} commands incl. ${expected.join(', ')}`)
    } else {
      fail('command list', `missing: ${missing.join(', ')}`)
    }
  } else {
    fail('command list endpoint', JSON.stringify(cmds.body))
  }

  // 3. create session A
  console.log('\n[3] create session A')
  const created = await api('/api/sessions', { method: 'POST', body: '{}' })
  if (!created.ok || !created.body.session) {
    fail('create session A', JSON.stringify(created.body))
    return
  }
  const sessionA = created.body.session.id
  pass(`session A = ${sessionA.slice(0, 8)}`)

  // 4. real user message → wait for assistant.completed
  console.log('\n[4] send user message → real model reply')
  const eventsPromise = waitForEvents(sessionA, ['message.assistant.completed'])
  const send = await api(`/api/sessions/${sessionA}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Remember: my favourite colour is sapphire blue. Reply with one short sentence acknowledging.',
    }),
  })
  if (!send.ok) {
    fail('send message', JSON.stringify(send.body))
    return
  }
  let eventsA
  try {
    eventsA = await eventsPromise
  } catch (err) {
    fail('wait for assistant.completed', err.message)
    return
  }
  const deltas = eventsA.filter((e) => e.type === 'message.assistant.delta')
  const completion = eventsA.find((e) => e.type === 'message.assistant.completed')
  const assistantText = deltas.map((d) => d.delta).join('')
  if (assistantText.length > 0) {
    pass(`assistant streamed ${deltas.length} deltas → "${assistantText.slice(0, 80)}"`)
  } else {
    fail('assistant content empty', JSON.stringify(completion))
  }
  if (completion?.tokensIn !== undefined || completion?.tokenCount !== undefined) {
    pass(`completion event includes token metadata`)
  }

  // 5. /sessions command
  console.log('\n[5] /sessions command')
  const listResult = await api(`/api/sessions/${sessionA}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'sessions', args: { limit: 10 } }),
  })
  if (listResult.body?.result?.kind === 'session_list') {
    const sess = listResult.body.result.sessions.find((s) => s.id === sessionA)
    if (sess && sess.turnCount >= 2) {
      pass(`/sessions returned ${listResult.body.result.sessions.length} sessions, current has ${sess.turnCount} turns`)
    } else {
      fail('/sessions turn count', `expected ≥2 turns, got ${sess?.turnCount}`)
    }
  } else {
    fail('/sessions result kind', JSON.stringify(listResult.body))
  }

  // 6. /help command
  console.log('\n[6] /help command')
  const help = await api(`/api/sessions/${sessionA}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'help', args: {} }),
  })
  if (help.body?.result?.kind === 'text' && help.body.result.content.includes('/sessions')) {
    pass('/help text mentions /sessions')
  } else {
    fail('/help', JSON.stringify(help.body))
  }

  // 7. /compact on a short session (should return "nothing to compact")
  console.log('\n[7] /compact on short session')
  const compactShort = await api(`/api/sessions/${sessionA}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'compact', args: {} }),
  })
  if (compactShort.body?.result?.kind === 'text' && /nothing to compact/i.test(compactShort.body.result.content)) {
    pass('/compact returns "nothing to compact" for short history')
  } else {
    fail('/compact short history', JSON.stringify(compactShort.body))
  }

  // 8. /clear without confirm (rejected)
  console.log('\n[8] /clear without confirm (must reject)')
  const clearDenied = await api(`/api/sessions/${sessionA}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'clear', args: {} }),
  })
  if (clearDenied.body?.result?.kind === 'error') {
    pass('/clear without confirm refused')
  } else {
    fail('/clear without confirm', JSON.stringify(clearDenied.body))
  }

  // 9. /load an unknown skill (rejected)
  console.log('\n[9] /load nonexistent skill (must reject)')
  const loadMissing = await api(`/api/sessions/${sessionA}/command`, {
    method: 'POST',
    body: JSON.stringify({ name: 'load', args: { skill: 'system/no-such-skill' } }),
  })
  if (loadMissing.body?.result?.kind === 'error') {
    pass('/load on unknown skill refused')
  } else {
    fail('/load unknown skill', JSON.stringify(loadMissing.body))
  }

  // 10. cross-session recall: create session B, ask about colour from A
  console.log('\n[10] cross-session recall via search_history')
  const createB = await api('/api/sessions', { method: 'POST', body: '{}' })
  if (!createB.ok) {
    fail('create session B', JSON.stringify(createB.body))
    return
  }
  const sessionB = createB.body.session.id
  pass(`session B = ${sessionB.slice(0, 8)}`)

  const eventsBPromise = waitForEvents(sessionB, ['message.assistant.completed'])
  await api(`/api/sessions/${sessionB}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: `What did I tell you my favourite colour was? Search prior conversations if needed (current session id is ${sessionB}, so exclude that).`,
    }),
  })
  let eventsB
  try {
    eventsB = await eventsBPromise
  } catch (err) {
    fail('session B wait', err.message)
    return
  }
  const replyB = eventsB
    .filter((e) => e.type === 'message.assistant.delta')
    .map((d) => d.delta)
    .join('')
  const toolCalled = eventsB.some((e) => e.type === 'tool.called' && e.tool === 'search_history')
  if (toolCalled) {
    pass('agent called search_history in session B')
  } else {
    fail('agent did not call search_history', `no tool.called event; reply: "${replyB.slice(0, 120)}"`)
  }
  if (/sapphire|blue/i.test(replyB)) {
    pass(`reply references the stored fact: "${replyB.slice(0, 120)}"`)
  } else {
    fail('agent did not recall fact', `reply: "${replyB.slice(0, 200)}"`)
  }

  // 11. /clear with confirm cleans the session — only when KEEP_SESSIONS isn't set
  if (process.env.KEEP_SESSIONS !== '1') {
    console.log('\n[11] /clear with confirm')
    const cleared = await api(`/api/sessions/${sessionB}/command`, {
      method: 'POST',
      body: JSON.stringify({ name: 'clear', args: { confirm: true } }),
    })
    if (cleared.body?.result?.kind === 'session_cleared' && cleared.body.result.turnsDeleted > 0) {
      pass(`/clear deleted ${cleared.body.result.turnsDeleted} turns; session record preserved`)
    } else {
      fail('/clear with confirm', JSON.stringify(cleared.body))
    }
    const afterClear = await api(`/api/sessions/${sessionB}`)
    if (afterClear.body?.turns?.length === 0) {
      pass('/clear left the session record present with 0 turns')
    } else {
      fail('post-clear session state', JSON.stringify(afterClear.body))
    }
  } else {
    console.log('\n[11] /clear SKIPPED (KEEP_SESSIONS=1) — session B preserved for inspection')
    console.log(`     session A: ${sessionA}`)
    console.log(`     session B: ${sessionB}`)
  }

  // Summary
  console.log(`\n— ${passes.length} passed, ${failures.length} failed —`)
  if (failures.length > 0) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  • ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Smoke crashed:', err)
  process.exit(2)
})
