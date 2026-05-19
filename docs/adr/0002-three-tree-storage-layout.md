# Three-tree storage layout on SharePoint

The SharePoint drive is partitioned into three sibling trees: `wiki/` (agent-authored markdown memory, accessed via Core Tools), `projects/` (stakeholder-authored project Documents — PDFs, CAD, scope docs — accessed read-mostly via the `system/documents` Skill), and `drafts/` (agent-generated non-Wiki outputs like proposal markdown or exported diagrams). The split keeps the Wiki's markdown index pure, makes stakeholder authorship visually obvious at the filesystem level, and lets sandboxed agents opt out of Document access by omitting the `system/documents` Skill from their profile without affecting Wiki access.

## Considered alternatives

- **One mixed tree per project** (`projects/alpha/` contains both `scope.pdf` and the agent's notes side-by-side): co-locates notes with source material, but conflates "what the stakeholder wrote" with "what the agent inferred." Pollutes the Wiki index with binary metadata.
- **Two trees (`wiki/` and `projects/`, no `drafts/`)**: simpler, but the agent's generated non-Wiki outputs (exported reports, generated diagrams) have nowhere clean to land — they either pollute `projects/` (looking stakeholder-authored) or stay only in the Wiki (the Wiki is markdown-only).
