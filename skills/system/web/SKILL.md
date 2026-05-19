---
name: web
description: Fetch a URL via HTTP. Returns status, headers, and body (text for text mime-types, base64-truncated metadata for binaries). Use for web research and API calls.
tools:
  - id: http_request
    handler: ./tools/http-request.ts
    description: Issue an HTTP request and return status, headers, and body. Supports GET/POST/PUT/PATCH/DELETE.
---

# Web

Issue HTTP requests to external services.

## Guidelines

- Always check the response status before treating the body as authoritative.
- For research, scrape sparingly and respect robots.txt where applicable.
- Anything you fetch leaves the machine — don't fetch URLs that include
  secrets without good reason.
- Use shorter timeouts for slow endpoints; the default is 15 seconds.
