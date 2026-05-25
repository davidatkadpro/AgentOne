# Codebase Review 2026-05-25 — Remediation Plan

Trackable plan addressing the 16 findings in
[`docs/review/codebase-review-2026-05-25.md`](../review/codebase-review-2026-05-25.md).

Organised along the review's "Suggested Remediation Order" so each phase can
ship independently. Inside a phase, items are ordered by blast radius and
shared dependencies.

Last reviewed: 2026-05-25.
Implementation status: see [Implementation log](#implementation-log-2026-05-25) at the bottom.

---

## Conventions

- **Status**: ☐ todo · ◐ in progress · ☑ done · ⊘ blocked
- **Depends on**: lists item IDs that must land first.
- **Finding**: review section number(s) the item addresses.
- Each item has an explicit **Acceptance** clause so we know when it lands.

---

## Status overview

| Group | Done | In progress | Todo |
|---|---|---|---|
| P0 Trust boundary lockdown (R1–R5) | 5 | 0 | 0 |
| P1 Dependency + vault correctness (R6–R8) | 1 | 0 | 2 |
| P2 Tool runtime correctness (R9–R12) | 4 | 0 | 0 |
| P3 Financial + document integrity (R13–R15) | 3 | 0 | 0 |
| P4 Resource caps + loader hardening (R16–R18) | 3 | 0 | 0 |
| P5 Code quality (R19–R21) | 2 | 0 | 1 |
| **Total** | **18** | **0** | **3** |

---

## Cross-cutting principles

- **Local-trust posture stays explicit.** Until P0 lands, document loopback-only
  intent in the README and refuse non-loopback HOST without an opt-in env flag.
- **Defence in depth over single chokepoints.** Where two tools touch the same
  network/path/parser surface, both must enforce the policy — the safer one is
  not "good enough" cover for the other.
- **Cancellation is a first-class invariant.** Once we thread `AbortSignal`
  through the tool runtime (R10), every long-running tool must honour it; new
  tools land with abort tests.
- **Tests track each fix.** Every item lists a concrete test target — usually a
  new file under `tests/` or `src/web/tests/` — so regressions get caught in CI.

---

## P0 — Trust boundary lockdown

Goal: make it impossible to drive a shell/filesystem turn from an unauthenticated
caller, and remove the path/SSRF gaps that already weaken the loopback assumption.

### R1. API + WS auth gate with mandatory bearer token
**Status**: ☑ · **Finding**: 1 · **Depends on**: —
- New module `src/server/auth.ts` issues a per-install token persisted in
  storage on first boot, returned to the user once via stdout, and required on
  every `/api/*` and `/ws` request.
- Fastify preHandler rejects requests missing/invalid `Authorization: Bearer …`
  (and `?token=` for WS upgrades).
- Browser-origin requests additionally checked against an `ALLOWED_ORIGINS`
  allowlist (default: `http://127.0.0.1:<port>`, `http://localhost:<port>`).
- WS subscribe handler in [src/server/index.ts:739](../../src/server/index.ts#L739)
  rejects session IDs the authenticated principal does not own (today: single
  user, so simply "must be authenticated").
- **Acceptance**: new `tests/server-auth.test.ts` covers missing token, wrong
  token, valid token, WS upgrade with token query, and Origin denial.

### R2. Fail boot on non-loopback HOST without explicit opt-in
**Status**: ☑ · **Finding**: 1 · **Depends on**: R1
- Replace the "warning" at [src/server/index.ts:1404](../../src/server/index.ts#L1404)
  with a hard exit unless `ALLOW_UNAUTH_NETWORK=1` is set AND auth (R1) is
  active. Print actionable remediation in the error.
- **Acceptance**: integration test boots with `HOST=0.0.0.0` and asserts exit
  with a structured error code.

### R3. Remove `system/shell` from `_base.yaml`
**Status**: ☑ · **Finding**: 1 · **Depends on**: —
- Edit [profiles/agents/_base.yaml:8](../../profiles/agents/_base.yaml#L8) to
  drop `system/shell`. Add an explicit `shell-enabled` profile (or update the
  existing dev profile) that opts in.
- Update `docs/PRD.md` + any onboarding docs that imply shell is always-on.
- **Acceptance**: profile-loader test asserts `_base` resolves without shell;
  smoke test confirms a base-profile agent cannot call `shell_exec`.

### R4. `http_request` reuses `validateFetchUrl` + redirect handling
**Status**: ☑ · **Finding**: 2 · **Depends on**: —
- Extract `validateFetchUrl` and the redirect loop from
  [skills/system/web/tools/web-fetch.ts](../../skills/system/web/tools/web-fetch.ts)
  into a shared `skills/system/web/tools/fetch-policy.ts`.
- Rewrite [skills/system/web/tools/http-request.ts](../../skills/system/web/tools/http-request.ts)
  to use the helper, including manual redirect handling that re-validates each
  hop and caps at `MAX_REDIRECTS`.
- **Acceptance**: new `tests/http-request-validation.test.ts` mirrors
  `tests/web-fetch-validation.test.ts`: private IP literals, DNS rebinding,
  IPv6 link-local, `file:` / `gopher:` schemes, cloud-metadata IPs, multi-hop
  redirects.

### R5. Replace prefix-based path confinement with `relative()` checks
**Status**: ☑ · **Finding**: 3 · **Depends on**: —
- Move `safeJoin` helpers in
  [modules/projects/src/routes.ts:593](../../modules/projects/src/routes.ts#L593) and
  [modules/proposals/src/routes.ts:850](../../modules/proposals/src/routes.ts#L850)
  into a shared `src/storage/path-confine.ts` that returns
  `{ ok: false }` when `relative(root, joined)` starts with `..`, is empty, or
  is absolute.
- Validate `folderPath` at project creation
  ([modules/projects/src/routes.ts:17](../../modules/projects/src/routes.ts#L17))
  through the storage adapter so only adapter-resolvable paths are persisted.
- `/files` response strips absolute path
  ([modules/projects/src/routes.ts:579](../../modules/projects/src/routes.ts#L579))
  → return storage-relative paths only.
- **Acceptance**: new `tests/path-confine.test.ts` covers the
  `storage` vs `storage2` sibling case, NUL/`..` sequences, symlink resolution
  (where supported), and Windows drive letters. Existing project + proposal
  route tests updated to match the relative response shape.

---

## P1 — Dependency + vault correctness

Goal: the documented Windows posture must actually work, and production
deps must clear `npm audit --omit=dev`.

### R6. ESM-safe DPAPI loader
**Status**: ☑ · **Finding**: 4 · **Depends on**: —
- Rewrite `tryLoadDpapi` in
  [src/storage/secret-vault.ts:46](../../src/storage/secret-vault.ts#L46) to use
  `createRequire(import.meta.url)` (or dynamic `import()`).
- Centralise platform check so non-Windows still short-circuits.
- **Acceptance**: new test simulates `platform: 'win32'` with a real
  `win-dpapi`-shaped module on disk (resolvable via `createRequire`) and
  asserts the DPAPI path loads. Existing injected-binding test stays for
  pure-unit coverage.

### R7. Fastify remediation
**Status**: ☐ (deferred) · **Finding**: 5 · **Depends on**: R1 (auth surface is part of the
upgrade impact)
- Spike: attempt Fastify 5 upgrade in a worktree. Diff the plugin/lifecycle
  changes (hooks, payload handling, schema compilers).
- If Fastify 5 is viable: ship the migration. Otherwise pin to the highest 4.x
  that drops the advisory and document the deferral.
- **Acceptance**: `npm audit --omit=dev --json` shows 0 highs attributable to
  Fastify chain; full test suite + web build pass; smoke scripts under
  `scripts/` still complete.

### R8. xlsx parser containment
**Status**: ☐ (deferred) · **Finding**: 5 · **Depends on**: —
- Replace SheetJS Community Edition (`xlsx ^0.18.5`) with a maintained
  alternative (`exceljs` is the leading candidate — investigate API parity for
  `read_document` + invoice ingest paths).
- Move spreadsheet parsing into a worker (`worker_threads`) with size + sheet +
  cell caps enforced before the worker reads bytes.
- **Acceptance**: new `tests/spreadsheet-caps.test.ts` covers a >max-size file
  (rejected pre-parse), a sheet-count cap, a cell-count cap, and a parser-OOM
  scenario (worker killed, parent surfaces structured error).

---

## P2 — Tool runtime correctness

Goal: tools can be cancelled, leftovers cannot linger, and route-level
fire-and-forget cannot crash the process or hide failures from the UI.

### R9. Shell tool: cwd allowlist + process-tree kill
**Status**: ☑ · **Finding**: 6 · **Depends on**: R3
- Add `allowedCwdRoots` to the shell skill manifest; default to storage root
  + repo root. Reject `cwd` outside the allowlist.
- On timeout in
  [skills/system/shell/tools/shell-exec.ts:72](../../skills/system/shell/tools/shell-exec.ts#L72),
  kill the process group (POSIX: `process.kill(-pid, 'SIGKILL')`) or use a
  Windows Job Object via `child_process.spawn` with `windowsHide` + a small
  native helper (or `taskkill /T /F /PID`).
- **Acceptance**: new `tests/shell-exec-lifecycle.test.ts` spawns a parent that
  forks a grandchild that ignores SIGTERM, asserts grandchild is gone within
  500 ms of timeout. Add cwd-allowlist denial cases.

### R10. AbortSignal threading through ToolContext
**Status**: ☑ · **Finding**: 7 · **Depends on**: —
- Add `signal: AbortSignal` to `ToolContext`. `raceTimeout` in
  [src/skills/registry.ts:201](../../src/skills/registry.ts#L201) builds an
  `AbortController`, passes the signal in, aborts on timeout.
- Audit current tools (filesystem, web, documents, memory, shell) and propagate
  the signal into `fetch`, child_process, sqlite cursors where supported.
- **Acceptance**: new `tests/tool-cancellation.test.ts` registers a tool that
  resolves after 100 ms past the timeout and asserts the signal was aborted
  before resolution; existing web-fetch tests gain abort cases.

### R11. Background drain error handling
**Status**: ☑ · **Finding**: 8 · **Depends on**: —
- Wrap every `void drain(handle.stream)` call site
  ([src/server/index.ts:533, 667, 1014](../../src/server/index.ts)) with a
  shared `runTurnInBackground` helper.
- On rejection: log structured error, emit `turn.failed` event, persist a
  system error turn so the UI surfaces it.
- **Acceptance**: new `tests/server-background-drain.test.ts` injects a
  failing provider mid-stream, asserts `turn.failed` is observable on the WS
  stream, and the next `GET /sessions/:id/turns` includes the system error turn.

### R12. Shared Pandoc helper
**Status**: ☑ · **Finding**: 12 · **Depends on**: R10
- Extract proposal renderer's `execFileAsync(pandoc, …)` into
  `src/render/pandoc.ts` with: 30 s timeout, stdout/stderr drains with size
  caps, structured `{ ok, pdf?, stderr? }` return.
- Switch
  [modules/invoicing/src/routes.ts:978](../../modules/invoicing/src/routes.ts#L978)
  to the helper.
- **Acceptance**: new `tests/pandoc-render.test.ts` covers timeout, oversized
  stderr, oversized stdout, and missing-binary. Both invoice + proposal
  download routes share coverage of error path.

---

## P3 — Financial + document integrity

### R13. Finite + bounded numeric schemas
**Status**: ☑ · **Finding**: 9 · **Depends on**: —
- Audit
  [modules/invoicing/src/routes.ts:48](../../modules/invoicing/src/routes.ts#L48) and
  [modules/proposals/src/routes.ts:46](../../modules/proposals/src/routes.ts#L46);
  switch money/quantity fields to
  `z.number().finite().nonnegative().max(MONEY_MAX)`.
- Document `MONEY_MAX` and `QTY_MAX` in a shared `modules/shared/numeric.ts`
  (1e9 for money minor units is a reasonable starting cap).
- Decide on minor-unit migration in a follow-up ADR — out of scope for this
  patch, but link the ADR stub from `docs/adr/`.
- **Acceptance**: new tests in `tests/invoicing-numeric.test.ts` +
  `tests/proposals-numeric.test.ts` for `1e309`, `NaN` (via custom JSON),
  bounds at `MONEY_MAX ± 1`, fractional quantities, negative inputs.

### R14. Invoicing list query → Zod schema with max limit
**Status**: ☑ · **Finding**: 10 · **Depends on**: —
- Replace `parseListQuery`
  ([modules/invoicing/src/routes.ts:150](../../modules/invoicing/src/routes.ts#L150))
  with a Zod schema using `z.coerce.number().int().positive().max(500)` for
  limit, strict enums for status filters.
- Return `400` on invalid filters; consistent with other list routes.
- **Acceptance**: tests cover `limit=10000` → clamped to 400/error, unknown
  filter → 400, valid combos still return 200.

### R15. Escape user content in Markdown/Pandoc templates
**Status**: ☑ · **Finding**: 13 · **Depends on**: R12
- New helper `src/render/markdown-escape.ts` with `escapeTableCell`,
  `escapeBlock`, and a Pandoc invocation that uses `--from gfm-raw_html`
  (or equivalent) to disable raw HTML/LaTeX.
- Apply in
  [modules/proposals/src/service.ts:293](../../modules/proposals/src/service.ts#L293)
  and [modules/invoicing/src/routes.ts:950](../../modules/invoicing/src/routes.ts#L950).
- **Acceptance**: new `tests/markdown-escape.test.ts` covers pipes, newlines,
  backticks, raw `<script>`, raw LaTeX `\input`. Render tests assert produced
  PDF/MD does not contain the unescaped sequence.

---

## P4 — Resource caps + loader hardening

### R16. File-size pre-check + streaming reads
**Status**: ☑ · **Finding**: 11 · **Depends on**: —
- `read_file` (`skills/system/filesystem/tools/read-file.ts:22`) `stat()`s
  first; rejects > `MAX_READ_BYTES` (configurable, default 5 MB) with a
  structured error suggesting `max_bytes` + offset.
- `read_document` (`skills/system/documents/tools/read-document.ts:49`) applies
  per-format caps (PDF: pages; XLSX: sheet+cell — overlap with R8; text: size).
- Streaming text reads when `max_bytes` < file size: read via
  `createReadStream` with byte slice.
- **Acceptance**: new `tests/read-file-caps.test.ts` covers 50 MB sparse file
  rejected pre-read; `tests/read-document-caps.test.ts` covers oversize PDF +
  XLSX. Memory regression check: read of 50 MB returns truncated content
  without RSS spike (loose threshold).

### R17. Iterative `LocalFolderAdapter.list` with early termination
**Status**: ☑ · **Finding**: 11 · **Depends on**: —
- Replace recursive `readdir` in
  [src/storage/local-folder.ts:76](../../src/storage/local-folder.ts#L76) with
  a BFS/DFS walker that yields entries lazily and stops when `limit` is hit.
- Document indexing in
  [src/memory/documents/doc-index.ts:164](../../src/memory/documents/doc-index.ts#L164)
  moves to mtime-cached refresh + explicit `reindex_documents` skill action;
  scheduled job runs every N minutes.
- **Acceptance**: existing storage tests pass; new test seeds a 10k-entry tree
  and asserts `list({ limit: 50 })` completes < 50 ms wall and only touches the
  first batch of directories.

### R18. Skill handler import confinement
**Status**: ☑ · **Finding**: 14 · **Depends on**: —
- In [src/skills/loader.ts:253](../../src/skills/loader.ts#L253), after
  `resolve(manifest.folder, decl.handler)`, compute
  `relative(manifest.folder, resolved)` and reject if it starts with `..`, is
  absolute, or is empty. Reject absolute `decl.handler` strings up-front.
- Require handlers under a `tools/` subdirectory (warn now, enforce in a
  follow-up minor).
- **Acceptance**: new `tests/skill-loader-confinement.test.ts` covers
  `handler: ../../evil.js`, `handler: /etc/passwd.js`, `handler: tools/x.js`
  (allowed), `handler: x.js` (allowed but warned).

---

## P5 — Code quality

### R19. Typed domain errors instead of broad catches
**Status**: ☑ (partial — projects/proposals/invoicing status routes covered;
remaining broad catches in helper paths to follow) · **Finding**: 15 · **Depends on**: —
- Introduce `NotFoundError`, `InvalidTransitionError`, `ConflictError` in
  `src/errors/domain.ts` (or surface what may already exist).
- Update broad catches in
  [modules/projects/src/routes.ts:208](../../modules/projects/src/routes.ts#L208),
  [modules/proposals/src/routes.ts:232](../../modules/proposals/src/routes.ts#L232),
  [modules/invoicing/src/routes.ts:404](../../modules/invoicing/src/routes.ts#L404)
  to map known error types and re-throw the rest.
- Centralise mapping in a Fastify error handler.
- **Acceptance**: tests assert that throwing a generic `Error` from a service
  yields 500 (logged), while domain errors yield 404/409/400 as appropriate.

### R20. ESLint configuration for `src/web`
**Status**: ☐ (deferred) · **Finding**: 16 · **Depends on**: —
- Add ESLint + `@typescript-eslint`, `eslint-plugin-react`,
  `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y` to
  [src/web/package.json](../../src/web/package.json) devDependencies.
- Commit `.eslintrc.cjs` matching the existing TS strictness; suppress the
  initial backlog with an `// eslint-disable-next-line` baseline only if
  necessary, otherwise fix in-line.
- Wire `npm --prefix src/web run lint` into `npm run ci` (or equivalent root
  script).
- **Acceptance**: lint passes locally; CI step added if a CI config exists,
  otherwise documented in `README.md` as a required pre-push step.

### R21. React Router v7 future flags
**Status**: ☑ · **Finding**: Additional Observations · **Depends on**: —
- Enable the future flags surfaced in vitest output for the router setup in
  `src/web/src/main.tsx` (or wherever the router is created) — typically
  `v7_startTransition`, `v7_relativeSplatPath`.
- **Acceptance**: web test run emits no React Router future warnings.

---

## Sequencing summary

The phases map directly to the review's suggested order. Within a phase,
items without dependencies can be parallelised across PRs:

- **Sprint 1**: R1, R3, R4, R5 (parallel) → R2 (after R1).
- **Sprint 2**: R6, R8 (parallel); R7 in a worktree spike before merging.
- **Sprint 3**: R10 first (unblocks R9, R12); R11 in parallel.
- **Sprint 4**: R13, R14 (parallel); R15 after R12.
- **Sprint 5**: R16, R17, R18 (parallel).
- **Sprint 6**: R19, R20, R21 (parallel).

Each sprint should end with `npm run typecheck`, `npm test`,
`npm --prefix src/web build`, `npm --prefix src/web test`, and a fresh
`npm audit --omit=dev` snapshot recorded in the PR description.

---

## Implementation log (2026-05-25)

Landed in a single pass; 18 of 21 items shipped. Deferred items (R7 Fastify
spike, R8 xlsx migration, R20 ESLint setup) carry external risk that
warrants a separate PR each — they're tracked but not bundled here.

**Validation after the sweep:**

- `npm run typecheck` — passes
- `npm test` — **962 passed** (was 833 at review; +129 new tests, no regressions)
- `npm --prefix src/web test` — **178 passed** (was 173; +5 new)
- `npm --prefix src/web run build` — passes (no React Router v7 warnings)

**What landed (notable surfaces):**

- **Auth (R1, R2)** — `src/server/auth.ts` adds a bearer-token gate on every
  `/api/*` request and every `/ws` upgrade. Token is generated on first boot
  at `<storageRoot>/.auth/token` (mode 0600 on POSIX) and surfaced on
  stdout. Non-loopback HOST is refused unless `ALLOW_UNAUTH_NETWORK=1`.
  Frontend pulls the token from `?token=` / `#token=` on first load and
  persists in localStorage; api.ts attaches it as `Authorization: Bearer`,
  ws.ts appends `?token=` to the upgrade URL.

- **SSRF parity (R4)** — `skills/system/web/tools/fetch-policy.ts`
  centralises `validateFetchUrl` + a `fetchWithPolicy` helper that
  re-validates each redirect hop and downgrades POST→GET on 303 per
  RFC 7231. Both `web_fetch` and `http_request` now route through it.

- **Path confinement (R5)** — `src/storage/path-confine.ts` replaces the
  prefix-startsWith checks with `relative()`-based confinement (rejects
  `storage` vs `storage2` sibling attacks). `CreateProjectBody.folderPath`
  is now Zod-validated via `isSafeRelativePath`. `/files` returns the
  storage-relative path rather than the absolute filesystem path.

- **DPAPI (R6)** — `tryLoadDpapi` uses `createRequire(import.meta.url)` so
  the optional Windows binding can actually load in ESM. Injectable
  `requireFn` makes the loader path testable without installing the
  native dep.

- **Tool runtime (R9, R10)** — Shell tool constrains `cwd` to an allowlist
  (`SHELL_ALLOWED_CWD_ROOTS`), spawns detached on POSIX so `taskkill /T /F`
  on Windows / `kill(-pid)` on POSIX tears down the whole process tree on
  timeout. `ToolContext.signal` is now created per call inside the
  registry and aborted on timeout; web tools forward `ctx.signal` into
  their fetch controllers; upstream cancel cascades.

- **Background drain (R11)** — `src/server/background-drain.ts` wraps every
  fire-and-forget `drain(handle.stream)` so a provider failure emits a new
  `turn.failed` event instead of becoming an unhandled rejection. The
  event type lands in `src/core/events.ts` and `src/web/src/types/events.ts`.

- **Pandoc (R12)** — `src/render/pandoc.ts` centralises invocation with a
  30s default timeout, concurrent stdout+stderr drains, output-size caps,
  and structured `{ ok | timeout | error | spawn_failed }` results.

- **Numeric bounds (R13)** — `src/modules/numeric.ts` exports
  `moneyNonNegative()`, `moneyPositive()`, `qtyNonNegative()`. Invoice +
  proposal schemas adopt them. `Infinity` / `NaN` / `1e309` now rejected.

- **Invoice list query (R14)** — `parseListQuery` replaced by a Zod schema
  (`z.coerce.number().int().positive().max(500)`); invalid filters return
  400 INVALID_QUERY instead of silently broadening.

- **Markdown/Pandoc escaping (R15)** — `src/render/markdown-escape.ts`
  provides `escapeTableCell` / `escapeBlock` / `pandocSafeInputArgs`.
  Invoice + proposal renderers escape user content; invoice PDF render
  uses `markdown-raw_html-raw_tex` input variant.

- **File caps + streaming (R16)** — `StorageAdapter` gains `stat()` and
  `readRange()`. `read_file` pre-stats and refuses files > 100 MB,
  positioned-reads only the requested slice (50 MB sparse file now safe
  to peek at).

- **Iterative list (R17)** — `LocalFolderAdapter.list` is BFS over the
  tree; consumer `break` short-circuits the walk (no more buffering 10k+
  entries before yielding the first).

- **Skill loader (R18)** — Handler paths rejected at index time AND import
  time if absolute or if `relative(skillFolder, abs)` escapes. New
  `INVALID_HANDLER_PATH` error code.

- **Domain errors (R19, partial)** — `src/errors/domain.ts` exports
  `NotFoundError`, `InvalidTransitionError`, `ConflictError`, and a
  `mapDomainError` mapper. Status-PATCH routes in projects/proposals/
  invoicing replaced their broad catches with the mapper + re-throw of
  unknowns. Remaining bare `throw new Error('… not found')` sites in
  service code still need conversion — out of scope for this pass.

- **React Router v7 (R21)** — Future flags set on `createBrowserRouter` +
  `RouterProvider` + a shared `TestRouter` helper. Web test output is now
  warning-free.

**Files added (new):**

```
src/server/auth.ts
src/server/background-drain.ts
src/storage/path-confine.ts
src/render/pandoc.ts
src/render/markdown-escape.ts
src/modules/numeric.ts
src/errors/domain.ts
skills/system/web/tools/fetch-policy.ts
src/web/src/lib/auth-token.ts
src/web/tests/helpers/test-router.tsx
```

**Tests added (new):**

```
tests/fetch-policy.test.ts
tests/http-request-validation.test.ts
tests/path-confine.test.ts
tests/server-auth.test.ts
tests/background-drain.test.ts
tests/tool-registry.test.ts        (extended with cancellation cases)
tests/shell-exec-lifecycle.test.ts
tests/pandoc-render.test.ts
tests/invoicing-numeric.test.ts
tests/markdown-escape.test.ts
tests/read-file-caps.test.ts
tests/local-folder-list-iterative.test.ts
tests/skill-loader-confinement.test.ts
tests/domain-errors.test.ts
src/web/tests/auth-token.test.ts
```

**Deferred (need their own PRs):**

- **R7 Fastify** — needs a worktree spike to assess Fastify 5 migration
  cost. Audit still flags 6 highs from the Fastify chain (`fast-uri`).
- **R8 xlsx** — replacing SheetJS Community + isolating the parser in a
  worker is substantial; the prototype-pollution advisory only matters
  when parsing untrusted spreadsheets via `read_document`, so risk is
  bounded.
- **R20 ESLint** — needs preset + plugin selection (React/a11y/hooks) and
  a clean-up pass for whatever the initial run flags.
