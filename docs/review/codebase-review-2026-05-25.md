# AgentOne Codebase Review

Date: 2026-05-25
Reviewer: Codex acting as Senior Software Engineer

## Scope

Reviewed the TypeScript/Fastify backend, React/Vite frontend, module services, skill/tool runtime, storage layer, and test/build health.

Validation run:

- `npm run typecheck` - passed
- `npm test` - passed, 80 files / 833 tests
- `npm --prefix src/web run build` - passed
- `npm --prefix src/web test` - passed, 28 files / 173 tests
- `npm audit --omit=dev --json` - failed with 6 high production vulnerabilities
- `npm --prefix src/web audit --omit=dev --json` - passed, 0 production vulnerabilities
- `npm --prefix src/web run lint` - failed because `eslint` is not installed

Overall, the project has a solid foundation: strict TypeScript is enabled, the test suite is broad, business logic is mostly behind service boundaries, and the storage adapter does meaningful path normalization. The main risks are around the local-agent trust boundary, inconsistent security guardrails between tools, unbounded file/document processing, and a few correctness gaps in financial/document rendering paths.

## Findings

### 1. High - API has no auth while default skills include shell/filesystem/web execution

Category: Security, Bugs & Edge Cases

Evidence:

- API routes create sessions and trigger model turns without authentication: `src/server/index.ts:443`, `src/server/index.ts:511`.
- WebSocket clients can subscribe to arbitrary session IDs supplied by query/message: `src/server/index.ts:739`.
- The server only prints a warning when bound to `0.0.0.0`: `src/server/index.ts:1404`.
- The base profile loads `system/filesystem`, `system/shell`, and `system/web`: `profiles/agents/_base.yaml:5`.
- The shell tool executes arbitrary shell commands: `skills/system/shell/tools/shell-exec.ts:23`.

Why this matters:

This is acceptable only as a strictly local, trusted, single-user app. If the server is exposed on a LAN, through a tunnel, or to a compromised browser context, an attacker can drive an agent turn that has access to shell execution and local file operations.

Recommendation:

Add a mandatory auth layer before supporting non-loopback hosts. At minimum, require a bearer token or signed local session cookie for all `/api` and `/ws` routes, enforce `Origin` checks for browser requests, and fail boot when `HOST=0.0.0.0` unless an explicit `ALLOW_UNAUTH_NETWORK=1` style override is set. Consider removing `system/shell` from `_base` and enabling it only in profiles that explicitly need it.

### 2. High - `http_request` bypasses the SSRF checks implemented for `web_fetch`

Category: Security

Evidence:

- `web_fetch` validates each URL and redirect target before fetching: `skills/system/web/tools/web-fetch.ts:41`, `skills/system/web/tools/web-fetch.ts:129`.
- `http_request` accepts an arbitrary URL and calls `fetch` directly: `skills/system/web/tools/http-request.ts:8`, `skills/system/web/tools/http-request.ts:21`.

Why this matters:

The web skill has two network tools with different security policies. A model or loaded skill can use `http_request` to reach localhost, link-local, private network services, cloud metadata endpoints, or internal admin panels that `web_fetch` would block.

Recommendation:

Reuse `validateFetchUrl` from `web-fetch.ts` in `http-request.ts`, including redirect validation. Add tests mirroring `tests/web-fetch-validation.test.ts` for `http_request`, covering private IP literals, DNS results, redirects, IPv6, and URL schemes.

### 3. High - Project file routes use an unsafe prefix check for path confinement

Category: Security, Bugs & Edge Cases

Evidence:

- `folderPath` is user-controlled on project creation: `modules/projects/src/routes.ts:17`.
- `/scope` and `/files` build filesystem paths from `project.folderPath`: `modules/projects/src/routes.ts:488`, `modules/projects/src/routes.ts:545`.
- `safeJoin` checks `joined.startsWith(normalizedRoot)`: `modules/projects/src/routes.ts:593`.
- The same pattern exists in proposal download helpers: `modules/proposals/src/routes.ts:850`.
- `/files` returns the absolute filesystem path: `modules/projects/src/routes.ts:579`.

Why this matters:

String prefix checks are not a safe directory boundary. For a storage root like `C:\repo\storage`, a path resolving to `C:\repo\storage2\...` starts with the same string but is outside the storage root. Because project `folderPath` can be supplied by clients, a poisoned row can make these routes list or read files in sibling directories.

Recommendation:

Replace prefix checks with `relative(root, joined)` and reject paths where the relative result starts with `..`, is absolute, or is empty when inappropriate. Validate `folderPath` at project creation through the same storage adapter boundary instead of storing arbitrary strings. Do not return absolute local paths from API responses; return storage-relative paths.

### 4. High - Windows DPAPI backend is effectively unreachable in ESM

Category: Security, Bugs & Edge Cases

Evidence:

- The project is ESM (`"type": "module"`): `package.json:5`.
- `tryLoadDpapi` calls bare `require('win-dpapi')`: `src/storage/secret-vault.ts:46`.
- Tests only cover DPAPI by injecting a stub binding: `tests/secret-vault.test.ts:50`.

Why this matters:

In an ES module, bare `require` is undefined. The `try/catch` will catch the resulting `ReferenceError`, so a real Windows install will not load DPAPI and will either fall back to AES-GCM with `QBO_TOKEN_KEY` or disable QBO token storage. That contradicts the documented Windows security posture.

Recommendation:

Use `createRequire(import.meta.url)` from `node:module` or dynamic `import()` for optional DPAPI packages. Add a test that simulates `platform: 'win32'` and verifies the loader path when a module is available, not only when `dpapiBinding` is injected.

### 5. High - Production dependency audit reports known vulnerabilities

Category: Security, Maintainability

Evidence:

- `fastify` is pinned to `^4.28.1`: `package.json:24`.
- `xlsx` is pinned to `^0.18.5`: `package.json:30`.
- `npm audit --omit=dev --json` reported 6 high vulnerabilities, including `fast-uri` via Fastify and SheetJS `xlsx` prototype pollution/ReDoS advisories.

Why this matters:

Fastify sits on the public request parsing path, and `xlsx` processes user-controlled spreadsheet content via document tools. Both are in production dependencies.

Recommendation:

Plan a Fastify 5 migration or identify the newest Fastify 4-compatible remediation if available. For `xlsx`, consider replacing SheetJS Community Edition with a maintained parser, isolating spreadsheet parsing in a worker process, and enforcing file size/sheet/cell caps.

### 6. Medium - Shell tool timeout may leave child processes running

Category: Performance & Efficiency, Security

Evidence:

- The shell tool runs through `shell: true`: `skills/system/shell/tools/shell-exec.ts:26`.
- On timeout it calls `child.kill('SIGKILL')`: `skills/system/shell/tools/shell-exec.ts:72`.
- `cwd` can be any supplied absolute or relative path: `skills/system/shell/tools/shell-exec.ts:10`.

Why this matters:

Killing the shell process does not reliably kill grandchildren spawned by the command, especially on Windows. A timed-out command can leave background processes running. The unrestricted `cwd` also lets shell commands operate outside the intended project/storage area.

Recommendation:

Constrain `cwd` to an allowlisted root unless a profile explicitly allows broader access. Track and terminate process groups/job objects on timeout. For common non-interactive operations, prefer structured tools or `execFile`-style command arrays over shell strings.

### 7. Medium - ToolRegistry timeouts do not cancel underlying handlers

Category: Bugs & Edge Cases, Performance & Efficiency

Evidence:

- Tool execution wraps handlers in `raceTimeout`: `src/skills/registry.ts:201`.
- The timeout only rejects the wrapper promise; it does not signal the handler: `src/skills/registry.ts:255`.

Why this matters:

After a timeout is reported to the model, the original handler can keep running and still mutate files, make network calls, write to the database, or consume CPU. That creates surprising side effects after the orchestrator has moved on.

Recommendation:

Add an `AbortSignal` to `ToolContext`, pass it into every tool, and require long-running tools to honor it. For subprocess tools, combine the signal with process-tree termination.

### 8. Medium - Fire-and-forget turn draining can create unhandled failures

Category: Bugs & Edge Cases, Maintainability

Evidence:

- Routes call `void drain(handle.stream)` after starting a turn: `src/server/index.ts:533`, `src/server/index.ts:667`, `src/server/index.ts:1014`.
- `drain` has no internal error handling: `src/server/index.ts:946`.
- Provider stream errors are rethrown from the orchestrator: `src/orchestrator/turn.ts:631`.

Why this matters:

The HTTP route returns `{ ok: true }` before the model turn completes. If the provider later fails, the rejection can be unhandled, and the UI may not receive a clear failed-turn event. This makes provider/network failures harder to diagnose and can destabilize the process depending on Node's unhandled rejection settings.

Recommendation:

Wrap all background drains with `.catch(...)` that logs a structured error, emits a `turn.failed` event, and persists a visible assistant/system error turn when appropriate.

### 9. Medium - Financial numeric inputs allow non-finite and extreme values

Category: Bugs & Edge Cases, Security

Evidence:

- Invoice and estimate schemas use `z.number().nonnegative()` or `z.number().positive()` without `.finite()` or upper bounds: `modules/invoicing/src/routes.ts:48`, `modules/proposals/src/routes.ts:46`.
- Services multiply and persist those values directly: `modules/invoicing/src/service.ts:661`, `modules/proposals/src/service.ts:475`.

Why this matters:

`z.number().nonnegative()` accepts `Infinity`. JSON payloads such as `1e309` parse to `Infinity`, so totals can become non-finite or absurdly large. That can corrupt invoice/estimate totals, PDF rendering, sync payloads, and UI calculations.

Recommendation:

Use `.finite()` and practical `.max(...)` bounds for money/quantity fields. Prefer integer minor units for currency (`cents`) or a decimal library if precision matters. Add tests for `1e309`, very large finite values, fractional quantities, and zero/negative edge cases.

### 10. Medium - Invoicing list query silently ignores invalid filters and has no max limit

Category: Performance & Efficiency, Code Quality

Evidence:

- `parseListQuery` manually parses query params and ignores invalid values: `modules/invoicing/src/routes.ts:150`.
- `limit` is parsed with `Number.parseInt` and no upper bound: `modules/invoicing/src/routes.ts:172`.
- The parsed limit is passed into SQL directly as `LIMIT ?`: `modules/invoicing/src/service.ts:820`.

Why this matters:

Other list routes cap limits at 500 and return `400` on invalid queries. This route can request very large result sets, and invalid filters are silently dropped, producing broader results than the caller intended.

Recommendation:

Replace `parseListQuery` with a Zod schema using `z.coerce.number().int().positive().max(500)`. Return `400` for invalid filters instead of silently widening the query.

### 11. Medium - Document and file reads load full content before applying caps

Category: Performance & Efficiency, Security

Evidence:

- `read_file` reads the full file before slicing to `max_bytes`: `skills/system/filesystem/tools/read-file.ts:22`.
- `read_document` reads the full document into memory before extraction and truncation: `skills/system/documents/tools/read-document.ts:49`.
- Document search refreshes before every search: `src/memory/documents/doc-index.ts:164`.
- Local folder listing uses recursive `readdir` before respecting caller limits: `src/storage/local-folder.ts:76`.

Why this matters:

A large PDF/XLSX/text file under storage can cause high memory use and slow searches even when the user asks for a small result. This is especially risky because document parsing also touches dependencies with known spreadsheet parsing vulnerabilities.

Recommendation:

Check file size before reading, enforce per-format maximums, and stream or range-read text files. Move document indexing to an explicit/background job with TTL or filesystem mtime cache. Make `LocalFolderAdapter.list` iterative so `limit` can short-circuit traversal.

### 12. Medium - Invoice PDF rendering lacks timeout/stderr handling

Category: Bugs & Edge Cases, Performance & Efficiency

Evidence:

- Invoice download can render PDF through Pandoc: `modules/invoicing/src/routes.ts:920`.
- `renderPdfViaPandoc` starts `pandoc` with no timeout and does not consume stderr: `modules/invoicing/src/routes.ts:978`.

Why this matters:

If Pandoc hangs, writes enough stderr to block, or receives pathological markdown, the request can hang indefinitely and leave a child process behind. Proposal rendering uses `execFileAsync` with a 30 second timeout, so behavior is inconsistent.

Recommendation:

Use a shared Pandoc helper with timeout, stdout/stderr drains, output-size caps, and process cleanup. Return stderr snippets in a sanitized error payload for operator debugging.

### 13. Medium - Generated Markdown/Pandoc documents interpolate unescaped user content

Category: Security, Bugs & Edge Cases

Evidence:

- Proposal line descriptions, project names, and client names are inserted directly into Markdown tables: `modules/proposals/src/service.ts:293`.
- Invoice line descriptions and notes are inserted directly into Markdown: `modules/invoicing/src/routes.ts:950`.

Why this matters:

Unescaped pipes/newlines break Markdown tables. More importantly, Pandoc can preserve raw HTML/LaTeX depending on output format, so user-controlled invoice/proposal text can affect the generated document beyond plain text. In local use this is mostly a document integrity issue, but it becomes a security concern if untrusted email/scope data flows into generated PDFs.

Recommendation:

Escape Markdown table cells and block content before rendering. Disable raw HTML/LaTeX in Pandoc where possible, or use a safer template renderer that treats user fields as text. Add tests for pipes, newlines, backticks, raw HTML, and LaTeX-like input.

### 14. Medium - Skill handler imports are not confined to the skill directory

Category: Security, Maintainability

Evidence:

- Skill tool handlers are resolved with `resolve(manifest.folder, decl.handler)`: `src/skills/loader.ts:253`.
- The resolved path is imported directly: `src/skills/loader.ts:255`.

Why this matters:

A malformed or malicious `SKILL.md` can reference `../..` or an absolute path and import code outside its skill folder. Skills are local/trusted today, but this weakens the boundary if skills are installed from external repositories or edited through tooling.

Recommendation:

Reject absolute handler paths and require the resolved path to remain under `manifest.folder`. Consider requiring handlers to live under a `tools/` subdirectory. Add loader tests for `../` and absolute-path handler declarations.

### 15. Low - Route error mapping often catches broad exceptions

Category: Code Quality & Best Practices, Maintainability

Evidence:

- Several status/update routes map any thrown error to `404` or `400`: `modules/projects/src/routes.ts:208`, `modules/proposals/src/routes.ts:232`, `modules/invoicing/src/routes.ts:404`.

Why this matters:

Broad catches can hide database errors, invariant violations, and programmer mistakes as user errors. This slows incident diagnosis and may cause clients to retry or compensate incorrectly.

Recommendation:

Use typed domain errors such as `NotFoundError`, `InvalidTransitionError`, and `ConflictError`. Let unexpected errors bubble to Fastify's error handler with structured logging.

### 16. Low - Web lint script is configured but not runnable

Category: Code Quality & Best Practices, Maintainability

Evidence:

- `src/web/package.json` defines `"lint": "eslint . --ext .ts,.tsx"`: `src/web/package.json:10`.
- `eslint` is not in `devDependencies`: `src/web/package.json:34`.
- Running `npm --prefix src/web run lint` fails with `'eslint' is not recognized`.

Why this matters:

The project has strong type/test coverage, but lint is currently a false signal in package scripts and cannot run in CI. This lets style, hook dependency, accessibility, and unused React code issues slip through.

Recommendation:

Either remove the lint script until configured or add ESLint and the relevant TypeScript/React plugins. Wire it into CI alongside typecheck and tests.

## Additional Observations

- Email HTML has both server-side sanitization and browser DOMPurify defense-in-depth, which is a good pattern: `modules/email/src/sanitize.ts:121`, `src/web/src/routes/modules/email/components/EmailBody.tsx:15`.
- The storage adapter rejects absolute paths and simple traversal for normal storage operations: `src/storage/local-folder.ts:97`.
- SQL queries generally use prepared statements. Dynamic SQL in invoice listing only interpolates placeholder strings, not user values: `modules/invoicing/src/service.ts:811`.
- React Router v7 future warnings appear during web tests. They are not failing today, but should be addressed before upgrading React Router.

## Suggested Remediation Order

1. Add auth/origin protection or enforce loopback-only operation; remove shell from the base profile unless explicitly enabled.
2. Fix `http_request` SSRF validation and project route path confinement.
3. Patch dependency vulnerabilities or isolate risky parsers.
4. Fix DPAPI loading, tool cancellation, and background drain error handling.
5. Add numeric bounds and document-render escaping for invoices/proposals.
6. Add file size/indexing caps and a working lint configuration.

