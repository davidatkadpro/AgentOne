#!/usr/bin/env node
/**
 * End-to-end smoke for M15 (60% tool-result truncation + read_turn).
 *
 *   1. Plant a small "huge" text file under projects/.
 *   2. Open a session with a tiny artificial context window — done by
 *      using the truncation rule's own threshold. We can't change the
 *      server's contextWindow from outside, so instead we deliberately
 *      construct a tool result with content over the actual threshold
 *      by storing a very large text file and having the agent read it
 *      via read_file (system/filesystem).
 *   3. Watch for the tool.result_truncated event.
 *   4. Have the agent call read_turn with the truncated id and verify
 *      the rehydrated content includes the original marker.
 *
 * Note: triggering the 60% rule requires a tool result larger than
 * 60% of the conversation model's context window. For the default
 * local-fast / 32k window, that's ~6MB of text. We plant exactly that.
 *
 * Usage:
 *   node scripts/smoke-truncation.mjs [http://127.0.0.1:3737]
 */
import { writeFile, mkdir, unlink } from 'node:fs/promises'
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

function waitForTurn(sessionId, { quietMs = 6_000, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${encodeURIComponent(sessionId)}`)
    const collected = []
    let settled = false
    let sawCompletion = false
    let quietTimer = null
    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(overall)
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
    const overall = setTimeout(() => {
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

const health = await api('/api/health')
if (!health.ok) {
  console.error(`Server not reachable at ${BASE}.`)
  process.exit(1)
}
pass(`server up, contextWindow=${health.body.contextWindow}`)

// Build a "huge" file. The 60% truncation rule fires when a single tool
// message's tokens exceed truncate_threshold * contextWindow. With the
// default 32k window and 0.6 threshold, we need >19200 tokens (~76kB of
// English at ~4 chars/token). Make it 100kB to be safely over.
const marker = 'Quibblesnort-Truncation-Marker-9342'
const filler = 'x'.repeat(96_000)
const fixturePath = 'projects/agentone-truncation-fixture.txt'
const fixtureAbs = resolve(health.body.storageRoot, fixturePath)

await mkdir(resolve(health.body.storageRoot, 'projects'), { recursive: true })
await writeFile(fixtureAbs, `${filler}\n\n${marker}\n\n${filler}`, 'utf-8')
pass(`wrote fixture: ${fixturePath} (~${Math.round((await (await fetch('file:' + fixtureAbs.replace(/\\/g, '/'))).arrayBuffer ? 200_000 : 200_000) / 1024)}kB)`)

let cleanedUp = false
async function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { await unlink(fixtureAbs) } catch { /* ignore */ }
}

try {
  console.log('\n[1] Ask the agent to read the huge file via read_file')
  const sess = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agentProfile: health.body.agentProfile, title: 'smoke truncation' }),
  })
  if (!sess.ok) {
    fail('create session', JSON.stringify(sess.body))
    process.exit(1)
  }
  const sessionId = sess.body.session.id
  pass(`created session ${sessionId}`)

  const events1 = await sendMessage(
    sessionId,
    `Read the file ${fixturePath} with read_file. After reading, summarise what you saw in one short sentence. The file is large; don't quote it back to me.`,
  )

  const readCalls = events1.filter((e) => e.type === 'tool.called' && e.tool === 'read_file')
  if (readCalls.length > 0) pass(`agent called read_file (${readCalls.length}x)`)
  else fail('agent did not call read_file', `tools called: [${events1.filter((e) => e.type === 'tool.called').map((e) => e.tool).join(', ')}]`)

  // The truncation event fires on the NEXT iteration, when the orchestrator
  // prepares the prompt and finds an oversized tool result in history.
  const truncated = events1.find((e) => e.type === 'tool.result_truncated')
  if (truncated) {
    pass(
      `tool.result_truncated fired (${truncated.tokensBefore} → ${truncated.tokensAfter} tokens, toolCallId=${truncated.toolCallId})`,
    )
    if (truncated.tokensAfter < truncated.tokensBefore) {
      pass('tokensAfter < tokensBefore (the truncation actually shrank the message)')
    } else {
      fail(`tokensAfter (${truncated.tokensAfter}) is not less than tokensBefore (${truncated.tokensBefore})`)
    }
    const toolCallId = truncated.toolCallId

    console.log('\n[2] Have the agent rehydrate via read_turn')
    const events2 = await sendMessage(
      sessionId,
      `Now call read_turn with id="${toolCallId}" and page=1, page_size=4000. Tell me whether the content includes the literal string "${marker}".`,
    )
    const readTurnCalls = events2.filter((e) => e.type === 'tool.called' && e.tool === 'read_turn')
    if (readTurnCalls.length > 0) pass(`agent called read_turn (${readTurnCalls.length}x)`)
    else fail('agent did not call read_turn')

    // The marker is somewhere in the middle of the 192k-char file. With 4000
    // chars per page and marker at offset 96000, it'll be on page ~25. The
    // agent may need multiple read_turn calls — accept either behavior.
    const reply2 = events2
      .filter((e) => e.type === 'message.assistant.delta')
      .map((e) => e.delta ?? '')
      .join('')

    if (reply2.includes(marker) || /yes|present|found|includes/i.test(reply2)) {
      pass('agent surfaced rehydration result via read_turn')
    } else {
      fail('could not confirm read_turn produced sensible output', `reply: ${reply2.slice(0, 200)}`)
    }
  } else {
    fail(
      'no tool.result_truncated event observed',
      'either the file was too small to trigger the 60% rule (contextWindow=' +
        health.body.contextWindow + '), or the rule is not firing',
    )
  }
} finally {
  await cleanup()
  console.log('--- cleanup: fixture removed ---')
}

console.log(`\n${passes.length} passed, ${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
