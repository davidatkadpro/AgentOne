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

  searchTurns(opts: SearchTurnsOptions): TurnSearchHit[]

  /** Single-query bulk turn count per session. */
  countTurnsBySession(sessionIds: string[]): Map<string, number>

  /** Hard-delete every turn (and via FK cascade every tool_call) in this session. */
  clearTurns(sessionId: string): number
}

export interface SearchTurnsOptions {
  query: string
  limit?: number
  offset?: number
  /** Restrict matches to one session (mutually exclusive with excludeSessionId). */
  sessionId?: string
  /** Drop matches from a session — typically the caller's current one. */
  excludeSessionId?: string
  /** Restrict by role. Defaults to all roles. */
  roles?: Role[]
}

export interface TurnSearchHit {
  turnId: string
  sessionId: string
  sessionTitle: string | null
  role: Role
  content: string
  snippet: string
  createdAt: number
  /** FTS5 bm25 rank — lower is more relevant. */
  rank: number
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
 * Schema migration. Bumps user_version so re-running is idempotent.
 *
 * v2 (M3): adds the 'tool' role to turns.role and a tool_call_id column on
 *   both turns and tool_calls.
 * v3: repairs a regression in earlier v2 builds where `ALTER TABLE turns
 *   RENAME TO turns_v1` rewrote `tool_calls.turn_id` to reference the
 *   now-dropped `turns_v1`, leaving a dangling FK that crashes every
 *   prepare against `tool_calls`. v2 itself is now guarded with
 *   legacy_alter_table=ON so the bug can't recur on fresh migrations.
 * v4 (M4): adds `turns_fts` (FTS5) over turns.content with AFTER
 *   INSERT/UPDATE/DELETE triggers to keep the index in sync, backfilling
 *   from any existing rows. This is the substrate for search_history.
 */
function migrate(db: Db): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0
  if (version >= 4) return

  if (version < 2) runV2Migration(db)
  if (version < 3) runV3Migration(db)
  if (version < 4) runV4Migration(db)
}

function runV2Migration(db: Db): void {
  const turnsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns'")
    .get()
  const toolCallsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'")
    .get()

  // legacy_alter_table=ON prevents SQLite from rewriting FK references in
  // *other* tables when we rename `turns` here. Without it, tool_calls.turn_id
  // gets pointed at turns_v1 — the bug v3 has to repair.
  const prevLegacy = db.pragma('legacy_alter_table', { simple: true }) as number
  db.pragma('legacy_alter_table = ON')
  try {
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
  } finally {
    db.pragma(`legacy_alter_table = ${prevLegacy ? 'ON' : 'OFF'}`)
  }
}

function runV4Migration(db: Db): void {
  const tx = db.transaction(() => {
    const ftsExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='turns_fts'")
      .get()

    if (!ftsExists) {
      db.exec(`
        CREATE VIRTUAL TABLE turns_fts USING fts5(
          session_id UNINDEXED,
          turn_id UNINDEXED,
          role UNINDEXED,
          content,
          tokenize = 'porter unicode61'
        );
      `)
      db.exec(`
        INSERT INTO turns_fts (session_id, turn_id, role, content)
        SELECT session_id, id, role, content FROM turns;
      `)
    }

    // DROP-IF-EXISTS + CREATE so a half-migrated db (fts table created but
    // triggers missing from a crashed earlier run) converges to the current
    // definition. migrate() returns early on user_version>=4, so this block
    // doesn't run on every boot.
    db.exec(`
      DROP TRIGGER IF EXISTS turns_fts_ai;
      DROP TRIGGER IF EXISTS turns_fts_ad;
      DROP TRIGGER IF EXISTS turns_fts_au;
    `)
    db.exec(`
      CREATE TRIGGER turns_fts_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts (session_id, turn_id, role, content)
        VALUES (NEW.session_id, NEW.id, NEW.role, NEW.content);
      END;
      CREATE TRIGGER turns_fts_ad AFTER DELETE ON turns BEGIN
        DELETE FROM turns_fts WHERE turn_id = OLD.id;
      END;
      CREATE TRIGGER turns_fts_au AFTER UPDATE ON turns BEGIN
        DELETE FROM turns_fts WHERE turn_id = OLD.id;
        INSERT INTO turns_fts (session_id, turn_id, role, content)
        VALUES (NEW.session_id, NEW.id, NEW.role, NEW.content);
      END;
    `)

    db.pragma('user_version = 4')
  })
  tx()
}

function runV3Migration(db: Db): void {
  const tcSql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_calls'")
    .get() as { sql?: string } | undefined
  // Only rebuild if the buggy v2 migration left a dangling FK. A clean
  // tool_calls table already references `turns` — nothing to do.
  const needsRepair = tcSql?.sql?.includes('turns_v1') ?? false

  if (needsRepair) {
    // PRAGMA foreign_keys is a no-op inside a transaction, so we set it here.
    // Disabling FKs lets us drop the stale tool_calls without cascading.
    db.pragma('foreign_keys = OFF')
    try {
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE tool_calls_new (
            id TEXT PRIMARY KEY,
            tool_call_id TEXT,
            turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
            tool TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_json TEXT,
            ok INTEGER,
            duration_ms INTEGER,
            created_at INTEGER NOT NULL
          );
        `)
        db.exec(`
          INSERT INTO tool_calls_new (id, tool_call_id, turn_id, tool, args_json, result_json, ok, duration_ms, created_at)
          SELECT id, tool_call_id, turn_id, tool, args_json, result_json, ok, duration_ms, created_at FROM tool_calls;
        `)
        db.exec('DROP TABLE tool_calls;')
        db.exec('ALTER TABLE tool_calls_new RENAME TO tool_calls;')
        db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);')
        db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_llm_id ON tool_calls(tool_call_id);')
        const violations = db.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) {
          throw new Error(`FK check failed after v3 repair: ${JSON.stringify(violations)}`)
        }
        db.pragma('user_version = 3')
      })
      tx()
    } finally {
      db.pragma('foreign_keys = ON')
    }
  } else {
    db.pragma('user_version = 3')
  }
}

export function createConversationStore(db: Db): ConversationStore {
  // SCHEMA first so `turns`/`tool_calls` exist on fresh DBs before v4
  // touches them. On existing DBs the `IF NOT EXISTS` clauses are no-ops, so
  // v2's stale-schema detection (and v3's FK-repair detection) still see the
  // original tables and migrate them in place.
  db.exec(SCHEMA)
  migrate(db)

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

  const countTurnsStmt = db.prepare(
    'SELECT session_id, COUNT(*) AS n FROM turns WHERE session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id',
  )
  const deleteTurnsStmt = db.prepare('DELETE FROM turns WHERE session_id = ?')

  const searchTurnsStmt = db.prepare<{
    query: string
    sessionId: string | null
    excludeSessionId: string | null
    rolesJson: string | null
    limit: number
    offset: number
  }>(`
    SELECT
      f.turn_id    AS turn_id,
      f.session_id AS session_id,
      f.role       AS role,
      -- column 3 = content in turns_fts (session_id, turn_id, role, content).
      -- Reorder the CREATE VIRTUAL TABLE columns and you must fix this index.
      snippet(turns_fts, 3, char(171), char(187), '…', 16) AS snippet,
      t.content    AS content,
      t.created_at AS created_at,
      s.title      AS session_title,
      f.rank       AS rank
    FROM turns_fts f
    JOIN turns t    ON t.id = f.turn_id
    JOIN sessions s ON s.id = f.session_id
    WHERE turns_fts MATCH @query
      AND (@sessionId IS NULL OR f.session_id = @sessionId)
      AND (@excludeSessionId IS NULL OR f.session_id != @excludeSessionId)
      AND (@rolesJson IS NULL OR f.role IN (SELECT value FROM json_each(@rolesJson)))
    ORDER BY f.rank
    LIMIT @limit OFFSET @offset
  `)

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

    countTurnsBySession(sessionIds) {
      const out = new Map<string, number>()
      if (sessionIds.length === 0) return out
      const rows = countTurnsStmt.all(JSON.stringify(sessionIds)) as Array<{
        session_id: string
        n: number
      }>
      for (const row of rows) out.set(row.session_id, row.n)
      for (const id of sessionIds) if (!out.has(id)) out.set(id, 0)
      return out
    },

    clearTurns(sessionId) {
      const info = deleteTurnsStmt.run(sessionId)
      return Number(info.changes)
    },

    searchTurns(opts) {
      // Callers (search_history tool) validate mutual exclusion of
      // sessionId/excludeSessionId before reaching here. The SQL itself
      // tolerates both being set — it would just AND them — but the
      // resulting query is incoherent. Documenting the contract via the
      // type union; not asserting here.
      const rows = searchTurnsStmt.all({
        query: opts.query,
        sessionId: opts.sessionId ?? null,
        excludeSessionId: opts.excludeSessionId ?? null,
        rolesJson: opts.roles && opts.roles.length > 0 ? JSON.stringify(opts.roles) : null,
        limit: opts.limit ?? 10,
        offset: opts.offset ?? 0,
      }) as TurnSearchRow[]
      return rows.map(rowToTurnSearchHit)
    },
  }
}

interface TurnSearchRow {
  turn_id: string
  session_id: string
  role: string
  snippet: string
  content: string
  created_at: number
  session_title: string | null
  rank: number
}

function rowToTurnSearchHit(row: TurnSearchRow): TurnSearchHit {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    role: parseRole(row.role),
    content: row.content,
    snippet: row.snippet,
    createdAt: row.created_at,
    rank: row.rank,
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
