const sessionsEl = document.getElementById('sessions')
const logEl = document.getElementById('log')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')
const newBtn = document.getElementById('new-session')

let currentSessionId = null
let activeAssistant = null
let ws = null

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
      body: JSON.stringify({ agentProfile: '_base' }),
    })
    const data = await res.json()
    if (data.session) await openSession(data.session.id)
  } catch (err) {
    renderMeta(`Failed to create session: ${err.message}`, 'error')
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.addEventListener('open', () => {
    if (currentSessionId) subscribeWs(currentSessionId)
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
    renderMeta('Disconnected. Retrying in 2s…', 'error')
    setTimeout(connectWs, 2000)
  })
}

function subscribeWs(sessionId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'subscribe', sessionId }))
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
  }
}

async function send() {
  if (!currentSessionId) return
  const text = inputEl.value.trim()
  if (!text) return
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
