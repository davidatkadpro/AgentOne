import { randomUUID } from 'node:crypto'
import type { Session, Turn, Role, Message } from '../core/types.js'
import { countTokens } from '../core/tokenizer.js'
import type { AgentEvent } from '../core/events.js'
import type { Db } from './db.js'

export interface ConversationStore {
  createSession(input: { agentProfile: string; title?: string | null }): Session
  getSession(id: string): Session | undefined
  listSessions(limit?: number): Session[]
  setSessionTitle(id: string, title: string): void

  appendTurn(input: {
    sessionId: string
    role: Role
    content: string
    toolCallId?: string | null
  }): Turn
  listTurns(sessionId: string): Turn[]
  getTurn(turnId: string): Turn | undefined

  appendToolCall(input: {
    turnId: string
    toolCallId: string
    tool: string
    argsJson: string
  }): { id: string }
  recordToolCallResult(input: {
    id: string
    resultJson: string
    ok: boolean
    durationMs: number
  }): void
  listToolCalls(turnId: string): StoredToolCall[]
  /** Single-query bulk fetch of every tool_call for a session, bucketed by turn_id. */
  listToolCallsBySession(sessionId: string): Map<string, StoredToolCall[]>

  logEvent(input: { sessionId: string | null; type: AgentEvent['type']; payload: AgentEvent }): void
}

export interface StoredToolCall {
  id: string
  toolCallId: string
  turnId: string
  tool: string
  argsJson: string
  resultJson: string | null
  ok: boolean | null
  durationMs: number | null
  createdAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  agent_profile TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  compressed_from TEXT,
  tool_call_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  ok INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_llm_id ON tool_calls(tool_call_id);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON event_log(session_id, created_at);
`

const VALID_ROLES: ReadonlySet<Role> = new Set(['system', 'user', 'assistant', 'tool'])

function parseRole(raw: string): Role {
  if (VALID_ROLES.has(raw as Role)) return raw as Role
  throw new Error(`Invalid role in store: ${raw}`)
}

interface SessionRow {
  id: string
  title: string | null
  agent_profile: string
  created_at: number
}

interface TurnRow {
  id: string
  session_id: string
  role: string
  content: string
  token_count: number
  created_at: number
  compressed_from: string | null
  tool_call_id: string | null
}

interface ToolCallRow {
  id: string
  tool_call_id: string
  turn_id: string
  tool: string
  args_json: string
  result_json: string | null
  ok: number | null
  duration_ms: number | null
  created_at: number
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    agentProfile: row.agent_profile,
    createdAt: row.created_at,
  }
}

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: parseRole(row.role),
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    compressedFrom: row.compressed_from,
    toolCallId: row.tool_call_id,
  }
}

function rowToToolCall(row: ToolCallRow): StoredToolCall {
  return {
    id: row.id,
    toolCallId: row.tool_call_id,
    turnId: row.turn_id,
    tool: row.tool,
    argsJson: row.args_json,
    resultJson: row.result_json,
    ok: row.ok === null ? null : row.ok === 1,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

/**
 * Schema migration. Bumps user_version so re-running is idempotent. M3 adds
 * the 'tool' role to turns.role and a tool_call_id column on both turns and
 * tool_calls. Existing M1/M2 databases get migrated in-place (data preserved).
 */
function migrate(db: Db): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0
  if (version >= 2) return

  const turnsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'")
    .get()
  const toolCallsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'")
    .get()

  const tx = db.transaction(() => {
    if (turnsExists) {
      const turnsCols = db.pragma('table_info(turns)') as Array<{ name: string }>
      const hasToolCallId = turnsCols.some((c) => c.name === 'tool_call_id')
      const sql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='turns'")
        .get() as { sql?: string } | undefined
      const hasToolRole = sql?.sql?.includes("'tool'") ?? false

      if (!hasToolCallId || !hasToolRole) {
        db.exec('ALTER TABLE turns RENAME TO turns_v1;')
        db.exec(`
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
            content TEXT NOT NULL,
            token_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            compressed_from TEXT,
            tool_call_id TEXT
          );
        `)
        db.exec(`
          INSERT INTO turns (id, session_id, role, content, token_count, created_at, compressed_from)
          SELECT id, session_id, role, content, token_count, created_at, compressed_from FROM turns_v1;
        `)
        db.exec('DROP TABLE turns_v1;')
        db.exec('CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);')
      }
    }

    if (toolCallsExists) {
      const tcCols = db.pragma('table_info(tool_calls)') as Array<{ name: string }>
      if (!tcCols.some((c) => c.name === 'tool_call_id')) {
        db.exec('ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT;')
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_tool_calls_llm_id ON tool_calls(tool_call_id);',
        )
      }
    }

    db.pragma('user_version = 2')
  })
  tx()
}

export function createConversationStore(db: Db): ConversationStore {
  migrate(db)
  db.exec(SCHEMA)

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, title, agent_profile, created_at) VALUES (?, ?, ?, ?)',
  )
  const selectSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const listSessionsStmt = db.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?',
  )
  const updateTitle = db.prepare('UPDATE sessions SET title = ? WHERE id = ?')

  const insertTurn = db.prepare(
    'INSERT INTO turns (id, session_id, role, content, token_count, created_at, tool_call_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const listTurnsStmt = db.prepare(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, id ASC',
  )
  const selectTurnStmt = db.prepare('SELECT * FROM turns WHERE id = ?')

  const insertToolCall = db.prepare(
    'INSERT INTO tool_calls (id, tool_call_id, turn_id, tool, args_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const updateToolCallResult = db.prepare(
    'UPDATE tool_calls SET result_json = ?, ok = ?, duration_ms = ? WHERE id = ?',
  )
  const listToolCallsStmt = db.prepare(
    'SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY created_at ASC, id ASC',
  )
  const listToolCallsBySessionStmt = db.prepare(`
    SELECT tc.*
    FROM tool_calls tc
    JOIN turns t ON tc.turn_id = t.id
    WHERE t.session_id = ?
    ORDER BY tc.created_at ASC, tc.id ASC
  `)

  const insertEvent = db.prepare(
    'INSERT INTO event_log (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
  )

  return {
    createSession({ agentProfile, title = null }) {
      const session: Session = {
        id: randomUUID(),
        title,
        agentProfile,
        createdAt: Date.now(),
      }
      insertSession.run(session.id, session.title, session.agentProfile, session.createdAt)
      return session
    },

    getSession(id) {
      const row = selectSession.get(id) as SessionRow | undefined
      return row ? rowToSession(row) : undefined
    },

    listSessions(limit = 50) {
      const rows = listSessionsStmt.all(limit) as SessionRow[]
      return rows.map(rowToSession)
    },

    setSessionTitle(id, title) {
      updateTitle.run(title, id)
    },

    appendTurn({ sessionId, role, content, toolCallId = null }) {
      const turn: Turn = {
        id: randomUUID(),
        sessionId,
        role,
        content,
        tokenCount: countTokens(content),
        createdAt: Date.now(),
        compressedFrom: null,
        toolCallId,
      }
      insertTurn.run(
        turn.id,
        turn.sessionId,
        turn.role,
        turn.content,
        turn.tokenCount,
        turn.createdAt,
        turn.toolCallId,
      )
      return turn
    },

    listTurns(sessionId) {
      const rows = listTurnsStmt.all(sessionId) as TurnRow[]
      return rows.map(rowToTurn)
    },

    getTurn(turnId) {
      const row = selectTurnStmt.get(turnId) as TurnRow | undefined
      return row ? rowToTurn(row) : undefined
    },

    appendToolCall({ turnId, toolCallId, tool, argsJson }) {
      const id = randomUUID()
      insertToolCall.run(id, toolCallId, turnId, tool, argsJson, Date.now())
      return { id }
    },

    recordToolCallResult({ id, resultJson, ok, durationMs }) {
      updateToolCallResult.run(resultJson, ok ? 1 : 0, durationMs, id)
    },

    listToolCalls(turnId) {
      const rows = listToolCallsStmt.all(turnId) as ToolCallRow[]
      return rows.map(rowToToolCall)
    },

    listToolCallsBySession(sessionId) {
      const rows = listToolCallsBySessionStmt.all(sessionId) as ToolCallRow[]
      const out = new Map<string, StoredToolCall[]>()
      for (const row of rows) {
        const call = rowToToolCall(row)
        const list = out.get(call.turnId) ?? []
        list.push(call)
        out.set(call.turnId, list)
      }
      return out
    },

    logEvent({ sessionId, type, payload }) {
      insertEvent.run(sessionId, type, JSON.stringify(payload), Date.now())
    },
  }
}

export function turnsToMessages(turns: Turn[], toolCallsByTurnId: Map<string, StoredToolCall[]>): Message[] {
  const out: Message[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const calls = toolCallsByTurnId.get(turn.id) ?? []
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: turn.content })
        continue
      }
      out.push({
        role: 'assistant',
        content: turn.content.length > 0 ? turn.content : null,
        tool_calls: calls.map((c) => ({
          id: c.toolCallId,
          type: 'function',
          function: { name: c.tool, arguments: c.argsJson },
        })),
      })
      for (const c of calls) {
        out.push({
          role: 'tool',
          tool_call_id: c.toolCallId,
          content: c.resultJson ?? '',
        })
      }
    } else if (turn.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: turn.toolCallId ?? '',
        content: turn.content,
      })
    } else {
      out.push({ role: turn.role, content: turn.content })
    }
  }
  return out
}

export function sumTurnTokens(turns: Turn[]): number {
  let total = 0
  for (const t of turns) total += t.tokenCount + 4
  return total + 2
}
