-- modules/invoicing v0.1.0 — initial schema (local-only).
--
-- QBO sync columns are present so we don't need a migration when sync lands,
-- but no qbo_connection table yet — the sync_status column defaults to
-- 'local' and stays there until v0.2.

CREATE TABLE invoice (
  id TEXT PRIMARY KEY,                                   -- ULID
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES proposal(id) ON DELETE SET NULL,
  /** Local-owned doc number `<project.number>-<seq>`, e.g. 25001-01. */
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'partial', 'paid', 'void')),
  subtotal REAL NOT NULL DEFAULT 0,                      -- pre-tax
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,                         -- subtotal + tax
  amount_paid REAL NOT NULL DEFAULT 0,
  due_date INTEGER,                                      -- ms epoch
  notes TEXT,
  -- QBO sync columns (populated when sync lands; ignored in v0.1)
  qbo_id TEXT,                                           -- QBO doc id
  qbo_doc_number TEXT,                                   -- QBO's own number
  sync_status TEXT NOT NULL DEFAULT 'local'
    CHECK (sync_status IN ('local', 'pending', 'synced', 'drift', 'failed')),
  last_synced_at INTEGER,
  last_error_json TEXT,
  previous_invoice_id TEXT REFERENCES invoice(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  issued_at INTEGER,
  paid_at INTEGER,
  UNIQUE (project_id, number)
);

CREATE INDEX idx_invoice_project ON invoice(project_id, created_at DESC);
CREATE INDEX idx_invoice_status ON invoice(status);
CREATE INDEX idx_invoice_sync ON invoice(sync_status) WHERE sync_status != 'local';
CREATE INDEX idx_invoice_due ON invoice(due_date) WHERE due_date IS NOT NULL AND status IN ('issued', 'partial');

CREATE TABLE invoice_line (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'fixed'
    CHECK (kind IN ('fixed', 'time_and_materials', 'unit')),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_invoice_line_invoice ON invoice_line(invoice_id, position);

CREATE TABLE payment (
  id TEXT PRIMARY KEY,                                   -- ULID
  invoice_id TEXT NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  amount REAL NOT NULL CHECK (amount > 0),
  received_at INTEGER NOT NULL,                          -- ms epoch
  method TEXT NOT NULL DEFAULT 'other'
    CHECK (method IN ('check', 'ach', 'card', 'wire', 'cash', 'other')),
  reference TEXT,                                        -- check #, ach ref, etc.
  notes TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_payment_invoice ON payment(invoice_id, received_at DESC);

-- `project_budget` is the canonical source for the project header's budget
-- chip. Always reflects current state — no cache invalidation needed.
-- `budget_total` is the sum of accepted estimates; if none, it's 0 and the
-- UI shows "no budget set". invoiced_total / paid_total ignore void invoices.
CREATE VIEW project_budget AS
SELECT
  p.id AS project_id,
  COALESCE(
    (SELECT SUM(line.line_total)
     FROM estimate e
     JOIN estimate_line line ON line.estimate_id = e.id
     WHERE e.project_id = p.id AND e.status = 'accepted'),
    0
  ) AS budget_total,
  COALESCE(
    (SELECT SUM(total) FROM invoice WHERE project_id = p.id AND status != 'void'),
    0
  ) AS invoiced_total,
  COALESCE(
    (SELECT SUM(amount_paid) FROM invoice WHERE project_id = p.id AND status != 'void'),
    0
  ) AS paid_total
FROM project p;
