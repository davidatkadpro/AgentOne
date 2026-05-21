import { parseSlashInput } from './slash-parser.js'
import { nextReconnectDelayMs, disconnectNoticeFor } from './ws-backoff.js'

const sessionsEl = document.getElementById('sessions')
const logEl = document.getElementById('log')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')
const newBtn = document.getElementById('new-session')

let currentSessionId = null
let activeAssistant = null
let ws = null
let wsSubscribedSession = null
/** Number of consecutive failed reconnect attempts — drives the backoff
 *  curve in ws-backoff.js. Reset to 0 on a successful open. */
let wsReconnectAttempts = 0
let wsReconnectTimer = null
/** Profile the server is configured with — used so the "New conversation"
 *  button stores the same profile metadata as the orchestrator actually runs. */
let serverAgentProfile = '_base'

function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled || !currentSessionId
}

function clearLog() {
  logEl.innerHTML = ''
  activeAssistant = null
}

function renderEmpty(text = 'Start a new conversation to begin.') {
  const empty = document.createElement('div')
  empty.className = 'empty'
  empty.textContent = text
  logEl.appendChild(empty)
}

function ensureAssistantNode() {
  if (activeAssistant) return activeAssistant
  const div = document.createElement('div')
  div.className = 'turn assistant'
  const head = document.createElement('div')
  head.className = 'role'
  head.textContent = 'assistant'
  const body = document.createElement('div')
  body.className = 'body'
  div.appendChild(head)
  div.appendChild(body)
  logEl.appendChild(div)
  activeAssistant = { wrapper: div, body, text: '' }
  return activeAssistant
}

function renderUserTurn(content) {
  const div = document.createElement('div')
  div.className = 'turn user'
  const head = document.createElement('div')
  head.className = 'role'
  head.textContent = 'user'
  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = content
  div.appendChild(head)
  div.appendChild(body)
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

function renderAssistantTurnStatic(content, toolCalls = []) {
  const div = document.createElement('div')
  div.className = 'turn assistant'
  const head = document.createElement('div')
  head.className = 'role'
  head.textContent = 'assistant'
  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = content
  div.appendChild(head)
  div.appendChild(body)
  for (const tc of toolCalls) {
    const chip = document.createElement('div')
    chip.className = 'tool-chip done ' + (tc.ok === false ? 'failed' : '')
    chip.textContent = `${tc.tool}${tc.ok === false ? ' ✕' : ' ✓'}${tc.durationMs ? ' (' + tc.durationMs + 'ms)' : ''}`
    div.appendChild(chip)
  }
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

function renderMeta(text, kind = 'info') {
  const div = document.createElement('div')
  div.className = `meta ${kind}`
  div.textContent = text
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

function attachToolChip(tool, toolCallId) {
  const slot = ensureAssistantNode()
  const chip = document.createElement('div')
  chip.className = 'tool-chip running'
  chip.dataset.toolCallId = toolCallId
  chip.textContent = `${tool} …`
  slot.wrapper.appendChild(chip)
  logEl.scrollTop = logEl.scrollHeight
}

function finaliseToolChip(toolCallId, ok, durationMs) {
  const slot = activeAssistant
  if (!slot) return
  const chip = slot.wrapper.querySelector(`[data-tool-call-id="${toolCallId}"]`)
  if (!chip) return
  chip.classList.remove('running')
  chip.classList.add('done')
  if (!ok) chip.classList.add('failed')
  const label = chip.textContent.replace(/\s*…$/, '')
  chip.textContent = `${label} ${ok ? '✓' : '✕'}${durationMs ? ' (' + durationMs + 'ms)' : ''}`
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions')
    const data = await res.json()
    sessionsEl.innerHTML = ''
    for (const s of data.sessions) {
      const item = document.createElement('div')
      item.className = 'session' + (s.id === currentSessionId ? ' active' : '')
      item.textContent = s.title || s.id.slice(0, 8)
      item.title = s.id
      item.addEventListener('click', () => openSession(s.id))
      sessionsEl.appendChild(item)
    }
  } catch (err) {
    renderMeta(`Failed to load sessions: ${err.message}`, 'error')
  }
}

async function openSession(id) {
  currentSessionId = id
  setSendEnabled(true)
  clearLog()
  try {
    const res = await fetch(`/api/sessions/${id}`)
    const data = await res.json()
    const callsByTurn = data.toolCalls || {}
    for (const t of data.turns) {
      if (t.role === 'user') renderUserTurn(t.content)
      else if (t.role === 'assistant') {
        const calls = callsByTurn[t.id] || []
        renderAssistantTurnStatic(
          t.content,
          calls.map((c) => ({ tool: c.tool, ok: c.ok, durationMs: c.durationMs })),
        )
      }
    }
    if (data.turns.length === 0) {
      renderEmpty('Conversation is empty. Send a message to begin.')
    }
  } catch (err) {
    renderMeta(`Failed to open session: ${err.message}`, 'error')
  }
  await loadSessions()
  subscribeWs(id)
}

async function createSession() {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Use the server's configured profile, not a hardcoded "_base".
      // Otherwise the session's stored agentProfile (used by /cost) drifts
      // from the orchestrator's actual profile loaded at server boot.
      body: JSON.stringify({ agentProfile: serverAgentProfile }),
    })
    const data = await res.json()
    if (data.session) await openSession(data.session.id)
  } catch (err) {
    renderMeta(`Failed to create session: ${err.message}`, 'error')
  }
}

async function loadServerInfo() {
  try {
    const res = await fetch('/api/health')
    const data = await res.json()
    if (data && typeof data.agentProfile === 'string') {
      serverAgentProfile = data.agentProfile
    }
  } catch {
    // Health probe is best-effort; createSession falls back to '_base'.
  }
}

function connectWs() {
  // Clear any pending reconnect timer — this call supersedes it.
  if (wsReconnectTimer !== null) {
    clearTimeout(wsReconnectTimer)
    wsReconnectTimer = null
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // Subscribe at handshake time via ?sessionId — race-free, no gap between
  // socket.open and a follow-up subscribe message. The legacy message path
  // is still wired below for adding/removing further subscriptions.
  const query = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : ''
  ws = new WebSocket(`${proto}://${location.host}/ws${query}`)
  wsSubscribedSession = currentSessionId
  ws.addEventListener('open', () => {
    if (wsReconnectAttempts > 0) {
      renderMeta(
        `Reconnected after ${wsReconnectAttempts} retr${wsReconnectAttempts === 1 ? 'y' : 'ies'}.`,
      )
      wsReconnectAttempts = 0
    }
    // If the current session changed before the socket opened, swap subs.
    if (currentSessionId && currentSessionId !== wsSubscribedSession) {
      subscribeWs(currentSessionId)
    }
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handleEvent(msg)
  })
  ws.addEventListener('close', () => {
    const delay = nextReconnectDelayMs(wsReconnectAttempts)
    const notice = disconnectNoticeFor(wsReconnectAttempts, delay)
    if (notice) renderMeta(notice, 'error')
    wsReconnectAttempts++
    wsReconnectTimer = setTimeout(connectWs, delay)
  })
}

function subscribeWs(sessionId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (wsSubscribedSession && wsSubscribedSession !== sessionId) {
      ws.send(JSON.stringify({ op: 'unsubscribe', sessionId: wsSubscribedSession }))
    }
    ws.send(JSON.stringify({ op: 'subscribe', sessionId }))
    wsSubscribedSession = sessionId
  }
}

function handleEvent(e) {
  if (!currentSessionId || e.sessionId !== currentSessionId) return
  switch (e.type) {
    case 'message.assistant.started':
      activeAssistant = null
      ensureAssistantNode()
      break
    case 'message.assistant.delta': {
      const slot = ensureAssistantNode()
      slot.text += e.delta
      slot.body.textContent = slot.text
      logEl.scrollTop = logEl.scrollHeight
      break
    }
    case 'message.assistant.completed':
      activeAssistant = null
      setSendEnabled(true)
      break
    case 'tool.called':
      attachToolChip(e.tool, e.toolCallId)
      break
    case 'tool.completed':
      finaliseToolChip(e.toolCallId, true, e.durationMs)
      break
    case 'tool.failed':
      finaliseToolChip(e.toolCallId, false)
      renderMeta(`${e.tool} failed: ${e.code} — ${e.message}`, 'error')
      break
    case 'skill.loading':
      renderMeta(`Loading skill: ${e.name}…`)
      break
    case 'skill.loaded':
      renderMeta(
        `Loaded skill ${e.name}` +
          (e.toolsRegistered.length ? ` (+${e.toolsRegistered.length} tool${e.toolsRegistered.length === 1 ? '' : 's'})` : ''),
      )
      break
    case 'skill.load_failed':
      renderMeta(`Skill ${e.name} failed to load: ${e.reason}`, 'error')
      break
    case 'context.compressing':
      renderMeta('Compressing context…')
      break
    case 'context.compressed':
      renderMeta(
        `Compressed ${e.turnsCompressed} turns (${e.tokensBefore} → ${e.tokensAfter} tokens)`,
      )
      break
    case 'context.compression_failed':
      renderMeta(`Compression failed: ${e.reason}. Falling back to truncation.`, 'error')
      break
    case 'context.truncated':
      renderMeta(`Context truncated (${e.bytesBefore} → ${e.bytesAfter} bytes).`)
      break
    case 'expert.consulted':
      renderMeta(
        `Consulted ${e.expert} — ${formatUsd(e.costUsd)} (in ${e.inputTokens} / out ${e.outputTokens}). ` +
          `Session total: ${formatUsd(e.sessionSpendUsd)}.`,
      )
      break
    case 'expert.budget_exceeded':
      renderMeta(
        `Expert call to ${e.expert} cost ${formatUsd(e.costUsd)} — exceeded per-call budget of ${formatUsd(e.perCallBudgetUsd)}.`,
        'error',
      )
      break
    case 'tool.hook_denied':
      renderMeta(`Tool ${e.tool} denied by hook "${e.hook}": ${e.reason}`, 'error')
      break
    case 'tool.hook_mocked':
      renderMeta(`Tool ${e.tool} mocked by hook "${e.hook}" (handler skipped).`)
      break
    case 'recall.injected':
      renderMeta(
        `Passive recall: ${e.sources.length} source${e.sources.length === 1 ? '' : 's'} (${e.sources
          .map((s) => `${s.kind}:${s.title}`)
          .join(', ')}).`,
      )
      break
  }
}

function formatUsd(n) {
  if (typeof n !== 'number') return '$?'
  // Six decimals tracks fractional-cent expert calls — matches the /cost
  // command's renderCostReport format so the units line up across UI surfaces.
  return `$${n.toFixed(6)}`
}

async function send() {
  if (!currentSessionId) return
  const text = inputEl.value.trim()
  if (!text) return
  if (text.startsWith('/')) {
    inputEl.value = ''
    await runSlashCommand(text)
    return
  }
  inputEl.value = ''
  renderUserTurn(text)
  setSendEnabled(false)
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const body = await res.text()
      renderMeta(`Server error: ${body}`, 'error')
      setSendEnabled(true)
    }
  } catch (err) {
    renderMeta(`Send failed: ${err.message}`, 'error')
    setSendEnabled(true)
  }
}


async function runSlashCommand(raw) {
  const parsed = parseSlashInput(raw)
  renderUserTurn(raw)
  // Confirm gate for destructive commands.
  if (parsed.name === 'clear') {
    if (!confirm('Delete every turn in this session? This cannot be undone.')) {
      renderMeta('Cancelled.')
      return
    }
    parsed.args.confirm = true
  }
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: parsed.name, args: parsed.args, text: parsed.text }),
    })
    if (!res.ok) {
      const body = await res.text()
      renderMeta(`Server error: ${body}`, 'error')
      return
    }
    const data = await res.json()
    await renderCommandResult(data.result)
  } catch (err) {
    renderMeta(`Command failed: ${err.message}`, 'error')
  }
}

async function renderCommandResult(result) {
  if (!result) return
  switch (result.kind) {
    case 'text':
      renderMeta(result.content)
      return
    case 'session_list':
      renderSessionList(result.sessions)
      return
    case 'session_switch':
      renderMeta(`Created session ${result.session.id.slice(0, 8)} — switching.`)
      await openSession(result.session.id)
      return
    case 'session_cleared':
      renderMeta(`Cleared ${result.turnsDeleted} turn${result.turnsDeleted === 1 ? '' : 's'} from this session.`)
      clearLog()
      renderEmpty('Conversation is empty. Send a message to begin.')
      return
    case 'skill_loaded':
      if (result.alreadyLoaded) {
        renderMeta(`Skill ${result.skill} is already loaded in this session.`)
      } else {
        renderMeta(
          `Loaded skill ${result.skill}` +
            (result.toolsRegistered.length
              ? ` (+${result.toolsRegistered.length} tool${result.toolsRegistered.length === 1 ? '' : 's'})`
              : ''),
        )
      }
      return
    case 'context_compacted':
      renderMeta(
        `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${
          result.tokensBefore - result.tokensAfter
        })`,
      )
      return
    case 'skill_invoked':
      renderMeta(
        `${result.alreadyLoaded ? 'Reused' : 'Loaded'} skill ${result.skill}` +
          (result.forwarded ? ' — forwarding text to model…' : ''),
      )
      return
    case 'error':
      renderMeta(result.message, 'error')
      return
    default:
      renderMeta(`Unknown command result: ${JSON.stringify(result)}`, 'error')
  }
}

function renderSessionList(sessions) {
  const div = document.createElement('div')
  div.className = 'cmd-session-list'
  if (sessions.length === 0) {
    div.textContent = 'No sessions yet.'
    div.className += ' empty'
    logEl.appendChild(div)
    return
  }
  for (const s of sessions) {
    const row = document.createElement('div')
    row.className = 'cmd-session' + (s.id === currentSessionId ? ' current' : '')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = s.title || s.id.slice(0, 8)
    const meta = document.createElement('span')
    meta.className = 'meta-cells'
    const when = new Date(s.createdAt).toLocaleString()
    meta.textContent = ` · ${s.turnCount} turns · ${when}`
    row.appendChild(title)
    row.appendChild(meta)
    row.title = s.id
    row.addEventListener('click', () => {
      if (s.id !== currentSessionId) openSession(s.id)
    })
    div.appendChild(row)
  }
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

newBtn.addEventListener('click', createSession)
sendBtn.addEventListener('click', send)
inputEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    send()
  }
})

connectWs()
loadSessions()
loadServerInfo()
