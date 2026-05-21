---
name: documents
description: Read and search PDF, Word (docx), and Excel (xlsx) files from the storage root. Use this for any non-plain-text file under projects/.
tools:
  - id: read_document
    handler: ./tools/read-document.ts
    description: Extract text from a PDF / DOCX / XLSX file. Optional pages= for PDFs and sheet= for XLSX let you narrow what's returned. Pass toc=true to get only the section list (PDF outline, DOCX headings, XLSX sheet names) without body text — useful before paginating a long document.
  - id: doc_search
    handler: ./tools/doc-search.ts
    description: FTS5 search across all indexed project documents. Returns ranked hits with snippets and paths. Faster than reading every file when you need to find which document contains a phrase. Index refreshes automatically on file mtime change.
---

# Documents

Many things under `projects/` are not plain text: scope documents (PDF),
meeting notes (DOCX), parts lists or schedules (XLSX). `read_document`
handles all three; `read_file` (from `system/filesystem`) refuses them.

## Format support

| Extension     | Library     | Notes |
|---------------|-------------|-------|
| `.pdf`        | pdf-parse   | Text-only extraction. Scanned PDFs without an OCR text layer return empty text — say so plainly rather than inventing content. Supports `pages` to slice large documents. |
| `.docx`       | mammoth     | Plain-text extraction; styling is dropped, but document structure (paragraphs, lists) is preserved. |
| `.xlsx`, `.xls` | xlsx (SheetJS) | Each sheet is rendered as a tab-separated table with a `## Sheet: <name>` heading. Use `sheet` to extract just one. |

## When to use

- **Reading a project document:** `glob` from `system/filesystem` first to
  see what's there, then `read_document` on the file of interest.
- **Quoting from a doc:** always include the source path when you quote.
- **Large PDF:** start with `pages: "1-2"` to see what the document is
  before pulling the whole thing.

## When NOT to use

- For markdown / text / JSON / CSV files under any tree, use
  `read_file` from `system/filesystem` — it's a thinner code path.
- Don't call this on the wiki — wiki pages are markdown; use `wiki_read`.

## Arguments

- `path` — POSIX path relative to the storage root.
- `pages` (PDF only) — page selection like `"1-3"`, `"1,3,5"`, `"7"`. If
  omitted, all pages are returned. Out-of-range page numbers are silently
  skipped.
- `sheet` (XLSX only) — sheet name or 0-based index. If omitted, every
  sheet is returned, each prefixed with a heading.
- `max_bytes` — cap on returned text size. Default 200 KB. The result is
  truncated at that boundary with `truncated: true` set.
