-- modules/proposals v0.1.0 — initial schema.
--
-- Estimate is a draft money document; Proposal is the issued artifact built
-- from an Estimate via a template. Both live separate from `scope` (which is
-- a markdown file at projects/<n>/in/<date>/scope.md, not a DB row).

CREATE TABLE estimate (
  id TEXT PRIMARY KEY,                                 -- ULID
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,                  -- 1, 2, 3 for revisions
  source_scope_path TEXT,                              -- e.g. projects/24001 - x/in/250523 - rfi/scope.md
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'accepted', 'rejected', 'superseded')),
  notes TEXT,
  previous_estimate_id TEXT REFERENCES estimate(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER                                   -- when accepted/rejected
);

CREATE INDEX idx_estimate_project ON estimate(project_id, created_at DESC);
CREATE INDEX idx_estimate_status ON estimate(status);
CREATE INDEX idx_estimate_prev ON estimate(previous_estimate_id)
  WHERE previous_estimate_id IS NOT NULL;

CREATE TABLE estimate_line (
  id TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES estimate(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fixed'
    CHECK (kind IN ('fixed', 'time_and_materials', 'unit')),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT,                                           -- 'hr', 'sf', 'each', null
  unit_price REAL NOT NULL DEFAULT 0,                  -- USD; tax handled separately
  line_total REAL NOT NULL DEFAULT 0,                  -- redundant with qty*unit_price; cached
  position INTEGER NOT NULL,                           -- ordering within estimate
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_estimate_line_estimate ON estimate_line(estimate_id, position);

CREATE TABLE proposal (
  id TEXT PRIMARY KEY,                                 -- ULID
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  estimate_id TEXT NOT NULL REFERENCES estimate(id) ON DELETE RESTRICT,
  /** Sequence within project — `<project.number>-P<seq>` displayed in the UI. */
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'accepted', 'rejected', 'superseded')),
  template_name TEXT NOT NULL DEFAULT 'default',       -- name of the template used to render
  rendered_markdown_path TEXT,                         -- relative path under storage root
  previous_proposal_id TEXT REFERENCES proposal(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  issued_at INTEGER,
  decided_at INTEGER,
  UNIQUE (project_id, number)
);

CREATE INDEX idx_proposal_project ON proposal(project_id, created_at DESC);
CREATE INDEX idx_proposal_status ON proposal(status);
CREATE INDEX idx_proposal_estimate ON proposal(estimate_id);
