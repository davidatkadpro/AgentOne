---
name: web
description: Search the web, fetch readable page content, and make raw HTTP requests. Use `web_search` to find sources, `web_fetch` to read pages as cleaned text, and `http_request` only for API calls or when raw bytes/headers are needed.
tools:
  - id: web_search
    handler: ./tools/web-search.ts
    description: Search the web via DuckDuckGo and return ranked results with title, url, and snippet. Pair with `web_fetch` to read a result's full content.
  - id: web_fetch
    handler: ./tools/web-fetch.ts
    description: Fetch a URL and return its readable content. HTML pages are converted to markdown-ish text (headings, lists, link URLs preserved; nav/footer/scripts stripped); non-HTML responses pass through. Follows redirects with SSRF protection.
  - id: http_request
    handler: ./tools/http-request.ts
    description: Issue an HTTP request and return raw status, headers, and body. Supports GET/POST/PUT/PATCH/DELETE. Use for APIs or when you need headers; for reading web pages, prefer `web_fetch`.
---

# Web

Search the web, fetch readable page content, and issue raw HTTP requests.

## Choosing a tool

- **Research / reading a page**: `web_search` → `web_fetch`. `web_fetch`
  strips scripts, styles, and navigation chrome, and emits markdown-ish
  text that costs roughly 10x fewer tokens than raw HTML.
- **APIs or non-HTML payloads**: `http_request`. It returns status,
  headers, and the raw body (text or base64) — use it when you need to
  POST JSON, read a `Set-Cookie`, or get exact bytes.

## Guidelines

- Start research with `web_search` to discover candidate URLs, then
  fetch the most promising one(s) with `web_fetch`. Don't fetch every
  result blindly — read the snippets first.
- Always check the response status before treating the body as authoritative.
- Scrape sparingly and respect robots.txt where applicable.
- Anything you fetch leaves the machine — don't fetch URLs that include
  secrets without good reason.
- Use shorter timeouts for slow endpoints; defaults are 15s (`http_request`)
  and 30s (`web_fetch`).
