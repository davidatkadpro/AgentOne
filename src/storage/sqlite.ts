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

  appendTurn(input: { sessionId: string; role: Role; content: string }): Turn
  listTurns(sessionId: string): Turn[]
  getTurn(turnId: string): Turn | undefined

  logEvent(input: { sessionId: string | null; type: AgentEvent['type']; payload: AgentEvent }): void
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
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  compressed_from TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON event_log(session_id, created_at);
`

const VALID_ROLES: ReadonlySet<Role> = new Set(['system', 'user', 'assistant'])

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
  }
}

export function createConversationStore(db: Db): ConversationStore {
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
    'INSERT INTO turns (id, session_id, role, content, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const listTurnsStmt = db.prepare(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC, id ASC',
  )
  const selectTurnStmt = db.prepare('SELECT * FROM turns WHERE id = ?')

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

    appendTurn({ sessionId, role, content }) {
      const turn: Turn = {
        id: randomUUID(),
        sessionId,
        role,
        content,
        tokenCount: countTokens(content),
        createdAt: Date.now(),
        compressedFrom: null,
      }
      insertTurn.run(
        turn.id,
        turn.sessionId,
        turn.role,
        turn.content,
        turn.tokenCount,
        turn.createdAt,
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

    logEvent({ sessionId, type, payload }) {
      insertEvent.run(sessionId, type, JSON.stringify(payload), Date.now())
    },
  }
}

export function turnsToMessages(turns: Turn[]): Message[] {
  return turns.map((t) => ({ role: t.role, content: t.content }))
}

export function sumTurnTokens(turns: Turn[]): number {
  let total = 0
  for (const t of turns) total += t.tokenCount + 4
  return total + 2
}
