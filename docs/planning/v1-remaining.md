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

## Latent bugs (real, not yet hit)

7. **Multi-profile runtime alignment**
   - Sessions persist their `agentProfile` in the store, but the
     orchestrator always uses the boot profile from `AGENT_PROFILE`.
   - Concrete failure mode: create session under `researcher`, restart
     server with `AGENT_PROFILE=_base`, open the session. The
     orchestrator uses `_base`'s skills/permissions/budgets for a
     session that was created under `researcher`.
   - Two paths to fix:
     - **Path A (strict)**: enforce single-profile-per-server. Refuse
       to open sessions whose `agentProfile` ≠ the boot profile.
     - **Path B (proper)**: orchestrator looks up the session's
       profile at `buildSessionState` time, builds the registry +
       passive recall + hooks against that profile.
   - Recommended: Path A short-term (one check, one error message),
     Path B when multi-profile is a real product need.

8. **Expert response latency** (PRD #40)
   - Server captures latency on `consult_expert` calls but doesn't
     surface it on the `expert.consulted` event payload.
   - Add `latencyMs: number` to the event type and emit it. One-field
     addition.

---

## Nice-to-have (do when you have a slow afternoon)

9. **AutoTitler trigger configurable**
   - Currently hardcoded at 3 assistant turns. Move into
     `agent_profile.yaml` so different agents can choose different
     thresholds. Default stays 3.
   - Add `auto_title: { enabled: boolean, trigger_after: number }`.

10. **DocumentIndex startup prime**
    - `ensureFresh()` runs lazily on first `doc_search`. For workloads
      with 50+ files this makes the first search slow.
    - Fix: kick off an `ensureFresh()` from server boot, fire-and-forget.
    - Trivial; one line.

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
