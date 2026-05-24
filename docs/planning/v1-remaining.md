# V1 — Remaining Work

Snapshot of outstanding items after the M14–M19 push. Items 1–3 are
being done in the pre-React-handoff sprint; items 4–10 are persisted
here so they survive across sessions.

Last reviewed: 2026-05-22 (the date the M14–M19 plan landed on `main`,
at commits `99a73de..5076cbe`).

---

## Pre-handoff (DONE — 2026-05-22)

1. ~~**`GET /api/profiles`**~~ — done in `src/server/profiles-and-drafts.ts`
   + the route in `src/server/index.ts`. Tests in
   `tests/profiles-and-drafts.test.ts`.

2. ~~**`GET /api/drafts`**~~ — done in the same module + route. Tests
   alongside the profile tests.

3. ~~**Live-test smokes**~~ — three scripts under `scripts/`:
   - `smoke-cancel.mjs` — cancel mid-stream, assert
     `turn.cancel_requested` + `turn.cancelled` fire
   - `smoke-truncation.mjs` — plant a ~200kB text file, have the agent
     read it via `read_file`, watch for `tool.result_truncated`, then
     call `read_turn` to rehydrate
   - `smoke-event-hooks.mjs` — two-phase: `--setup` writes a temp
     `hooks.yaml`, user restarts with `EVENT_HOOKS_PATH=`, `--verify`
     sends a message and confirms the hook log grew

---

## Operational hardening (DONE — 2026-05-22)

4. ~~**DB backup script**~~ — done. `src/storage/backup.ts` wraps
   better-sqlite3's online-backup API; `scripts/backup-db.mjs` is the
   CLI; `/backup` is a slash command that writes to
   `<storageRoot>/backups/agentone-<timestamp>.db` by default. Scheduled
   backups (`BACKUP_INTERVAL_HOURS`) deferred — manual + cron is enough
   for v1.

5. ~~**Drafts cleanup story**~~ — done. `auto_distill.drafts_max_age_days`
   in the profile YAML; AutoDistillScheduler.pruneDraftsIfConfigured()
   runs at the start of each scan and emits `drafts.pruned` with the
   deleted paths. Default 0 = disabled (drafts retain forever).

6. ~~**Embedding indexer escalation**~~ — done. `consecutiveFailures`
   counter on the indexer, configurable `failureEscalationStep` (default
   10). `embedding.failed` event gains a `consecutiveFailures` field;
   emit fires on the 1st, then every Nth, then resets on success.

---

## Latent bugs (DONE — 2026-05-22)

7. ~~**Multi-profile runtime alignment**~~ — Path A shipped.
   `ProfileMismatchError` thrown from
   [src/orchestrator/turn.ts](../../src/orchestrator/turn.ts)
   `buildSessionState` when a session's persisted `agentProfile` differs
   from the boot profile; server maps the same condition to `409
   PROFILE_MISMATCH` on `POST /api/sessions`, `/messages`, and
   `/command`. `POST /api/sessions` now defaults the agentProfile to the
   boot profile when omitted. Path B (resolve per-session at
   buildSessionState time) is the long-term answer when multi-profile is
   a real product need.

8. ~~**Expert response latency**~~ (PRD #40) — done. `latencyMs: number`
   added to the `expert.consulted` event type; measured around the
   `provider.chat()` call in
   [skills/experts/consult/tools/consult.ts](../../skills/experts/consult/tools/consult.ts).
   Frontend prints it next to in/out tokens. Frontend handoff doc updated.

---

## Nice-to-have (DONE — 2026-05-24)

9. ~~**AutoTitler trigger configurable**~~ — done. `auto_title:
   { enabled, trigger_after }` added to the agent-profile schema in
   [src/profiles/agent-profile.ts](../../src/profiles/agent-profile.ts);
   resolved as `autoTitle: { enabled, triggerAfter }`. Default stays
   `{ enabled: true, triggerAfter: 3 }` to preserve the historical
   hardcoded behaviour. Server boot in
   [src/server/index.ts](../../src/server/index.ts) skips constructing
   the `AutoTitler` entirely when `enabled: false`. Tests in
   [tests/agent-profile.test.ts](../../tests/agent-profile.test.ts).

10. ~~**DocumentIndex startup prime**~~ — done. Server boot now
    fires `documents.ensureFresh().catch(() => {})` immediately after
    creating the `DocumentIndex`, so the first `doc_search` no longer
    pays the full indexing cost. Failures are silently swallowed —
    `search()` still calls `ensureFresh()` lazily as a safety net.

---

## Things explicitly NOT in v1

These match the PRD's "Out of Scope" section and stay deferred:

- Sub-agents (`spawn_agent`)
- Worker-thread isolation for skills
- MCP server consumption
- OpenAPI-driven skills as a first-class type
- OCR / vision pipelines for scanned PDFs
- Multi-user concurrency
- Mobile UI (the React rewrite is browser-first)
- Webhook-based SharePoint notification
- Comprehensive admin UI (settings editor, profile editor, hook editor)
- Cross-machine session sync beyond what OneDrive does for files

---

## Cross-references

- PRD: [`../PRD.md`](../PRD.md)
- Frontend handoff: [`../FRONTEND-HANDOFF.md`](../FRONTEND-HANDOFF.md)
- ADRs: [`../adr/`](../adr/)
