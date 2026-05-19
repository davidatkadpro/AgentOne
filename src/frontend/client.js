const sessionsEl = document.getElementById('sessions')
const logEl = document.getElementById('log')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send')
const newBtn = document.getElementById('new-session')

let currentSessionId = null
let assistantBuffer = ''
let assistantNode = null
let ws = null

function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled || !currentSessionId
}

function renderTurn(role, content) {
  const div = document.createElement('div')
  div.className = `turn ${role}`
  const head = document.createElement('div')
  head.className = 'role'
  head.textContent = role
  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = content
  div.appendChild(head)
  div.appendChild(body)
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
  return body
}

function renderMeta(text, isError = false) {
  const div = document.createElement('div')
  div.className = `meta${isError ? ' error' : ''}`
  div.textContent = text
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
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
    renderMeta(`Failed to load sessions: ${err.message}`, true)
  }
}

async function openSession(id) {
  currentSessionId = id
  setSendEnabled(true)
  logEl.innerHTML = ''
  try {
    const res = await fetch(`/api/sessions/${id}`)
    const data = await res.json()
    for (const t of data.turns) renderTurn(t.role, t.content)
    if (data.turns.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'Conversation is empty. Send a message to begin.'
      logEl.appendChild(empty)
    }
  } catch (err) {
    renderMeta(`Failed to open session: ${err.message}`, true)
  }
  await loadSessions()
  subscribeWs(id)
}

async function createSession() {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentProfile: 'default' }),
    })
    const data = await res.json()
    if (data.session) await openSession(data.session.id)
  } catch (err) {
    renderMeta(`Failed to create session: ${err.message}`, true)
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
    renderMeta('Disconnected. Retrying in 2s…', true)
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
      assistantBuffer = ''
      assistantNode = renderTurn('assistant', '')
      break
    case 'message.assistant.delta':
      if (!assistantNode) assistantNode = renderTurn('assistant', '')
      assistantBuffer += e.delta
      assistantNode.textContent = assistantBuffer
      logEl.scrollTop = logEl.scrollHeight
      break
    case 'message.assistant.completed':
      assistantNode = null
      setSendEnabled(true)
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
      renderMeta(`Compression failed: ${e.reason}. Falling back to truncation.`, true)
      break
  }
}

async function send() {
  if (!currentSessionId) return
  const text = inputEl.value.trim()
  if (!text) return
  inputEl.value = ''
  renderTurn('user', text)
  setSendEnabled(false)
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const body = await res.text()
      renderMeta(`Server error: ${body}`, true)
      setSendEnabled(true)
    }
  } catch (err) {
    renderMeta(`Send failed: ${err.message}`, true)
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
