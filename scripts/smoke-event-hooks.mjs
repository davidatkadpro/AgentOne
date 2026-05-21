#!/usr/bin/env node
/**
 * End-to-end smoke for M17 (settings-driven event hooks).
 *
 *   1. Write a temporary hooks.yaml + a hook handler that appends each
 *      received event to a file.
 *   2. Tell the user to restart the server with EVENT_HOOKS_PATH set
 *      to our temp path (no way to load hooks at runtime — config is
 *      read at boot).
 *   3. After restart, send a message in a fresh session and watch the
 *      file accumulate JSONL lines.
 *
 * Two-phase smoke (unlike the others): we can't restart the server
 * from here, so the first run writes the fixture and exits with
 * instructions; a second run after restart actually verifies.
 *
 * Usage:
 *   # Phase 1 (writes fixture + instructions):
 *   node scripts/smoke-event-hooks.mjs [http://127.0.0.1:3737] --setup
 *
 *   # User restarts server with EVENT_HOOKS_PATH=<printed path>.
 *
 *   # Phase 2 (verifies):
 *   node scripts/smoke-event-hooks.mjs [http://127.0.0.1:3737] --verify
 */
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] && process.argv[2].startsWith('http')
  ? process.argv[2]
  : 'http://127.0.0.1:3737'
const PHASE = process.argv.includes('--verify') ? 'verify' : 'setup'
const WS_BASE = BASE.replace(/^http/, 'ws')

// Stable temp dir so phase 2 can find what phase 1 wrote.
const FIXTURE_DIR = join(tmpdir(), 'agentone-smoke-event-hooks')
const HOOKS_YAML = join(FIXTURE_DIR, 'hooks.yaml')
const HANDLER_JS = join(FIXTURE_DIR, 'log-handler.mjs')
const LOG_FILE = join(FIXTURE_DIR, 'events.jsonl')

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
    let settled = false
    let sawCompletion = false
    let quietTimer = null
    const done = (err) => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      if (quietTimer) clearTimeout(quietTimer)
      ws.close()
      err ? reject(err) : resolve()
    }
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => done(null), quietMs)
    }
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data)
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
      done(new Error(`timeout — sawCompletion=${sawCompletion}`))
    }, timeoutMs)
  })
}

async function phaseSetup() {
  console.log('=== Phase 1: setup ===\n')
  await mkdir(FIXTURE_DIR, { recursive: true })

  // Clean any previous log file.
  try { await rm(LOG_FILE) } catch { /* ignore */ }

  await writeFile(
    HANDLER_JS,
    `import { appendFile } from 'node:fs/promises'

const LOG = ${JSON.stringify(LOG_FILE)}

export default async function logEvent(event) {
  // Skip the high-frequency delta events to keep the log readable.
  if (event.type === 'message.assistant.delta') return
  await appendFile(LOG, JSON.stringify({ ts: event.ts, type: event.type, sessionId: event.sessionId ?? null }) + '\\n', 'utf-8')
}
`,
    'utf-8',
  )

  await writeFile(
    HOOKS_YAML,
    `- on: '*'
  handler: './log-handler.mjs'
  description: smoke-test event tap
`,
    'utf-8',
  )

  pass(`wrote handler: ${HANDLER_JS}`)
  pass(`wrote hooks.yaml: ${HOOKS_YAML}`)
  pass(`log file (created on first event): ${LOG_FILE}`)

  console.log('')
  console.log('Next steps:')
  console.log(`  1. Stop the running server.`)
  console.log(`  2. Set EVENT_HOOKS_PATH=${HOOKS_YAML}`)
  console.log(`  3. Restart the server (npm start).`)
  console.log(`     Look for "Event hooks: 1 loaded from ..." in the startup log.`)
  console.log(`  4. Re-run this smoke with --verify:`)
  console.log(`     node scripts/smoke-event-hooks.mjs ${BASE} --verify`)
  console.log('')
  console.log(`(${passes.length} passed, ${failures.length} failed in setup)`)
}

async function phaseVerify() {
  console.log('=== Phase 2: verify ===\n')
  if (!existsSync(HOOKS_YAML)) {
    fail('hooks.yaml fixture missing', `expected at ${HOOKS_YAML}; re-run --setup first`)
    process.exit(1)
  }

  // Send a message that produces several distinct events.
  const sess = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'smoke event hooks', agentProfile: (await api('/api/health')).body.agentProfile }),
  })
  if (!sess.ok) {
    fail('create session', JSON.stringify(sess.body))
    process.exit(1)
  }
  const sessionId = sess.body.session.id
  pass(`created session ${sessionId}`)

  // Pre-existing log lines may exist from a prior run. Capture the
  // baseline byte size and assert NEW lines accumulate.
  let baseline = 0
  try { baseline = (await readFile(LOG_FILE, 'utf-8')).length } catch { /* file doesn't exist yet */ }

  const turnP = waitForTurn(sessionId)
  await api(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Say hello in one short sentence.' }),
  })
  await turnP
  pass('turn completed')

  // Give the appendFile calls a moment to flush.
  await new Promise((r) => setTimeout(r, 200))

  let logContent = ''
  try { logContent = await readFile(LOG_FILE, 'utf-8') } catch { /* still missing */ }

  if (logContent.length <= baseline) {
    fail(
      'hook log file did not grow during the turn',
      `baseline=${baseline} bytes, after=${logContent.length}. ` +
        'Either the server wasn\'t restarted with EVENT_HOOKS_PATH, ' +
        'the hooks.yaml failed to load (check server log), or the handler errored silently.',
    )
    process.exit(1)
  }
  pass(`hook log grew: ${baseline} → ${logContent.length} bytes`)

  // Parse the new content and check we saw a sensible variety of events.
  const newContent = logContent.slice(baseline)
  const lines = newContent.trim().split('\n').filter(Boolean)
  const types = new Set(lines.map((l) => JSON.parse(l).type))
  console.log(`  ${lines.length} new event lines, types: [${[...types].join(', ')}]`)

  if (types.has('message.user.received')) pass('captured message.user.received')
  else fail('missing message.user.received in log')

  if (types.has('message.assistant.completed')) pass('captured message.assistant.completed')
  else fail('missing message.assistant.completed in log')

  console.log(`\n${passes.length} passed, ${failures.length} failed.`)
  process.exit(failures.length === 0 ? 0 : 1)
}

if (PHASE === 'setup') {
  await phaseSetup()
} else {
  await phaseVerify()
}
