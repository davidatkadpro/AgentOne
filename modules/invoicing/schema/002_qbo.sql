-- modules/invoicing v0.2.0 — QBO sync columns + qbo_connection table.
--
-- Adds the operator-level QBO connection row (single row, enforced by
-- CHECK (id = 1)) plus the per-invoice drift snapshot column used by the
-- pull route to render side-by-side diffs without re-fetching from QBO.

CREATE TABLE qbo_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id TEXT NOT NULL,
  company_name TEXT,
  -- Encrypted access + refresh tokens. DPAPI on Windows, AES-GCM elsewhere.
  -- BLOB columns so we don't have to worry about utf-8 surrogate halves.
  access_token_encrypted BLOB NOT NULL,
  refresh_token_encrypted BLOB NOT NULL,
  -- Token expiry is the access token's; refresh is renewed on use.
  token_expires_at INTEGER NOT NULL,
  connected_at INTEGER NOT NULL,
  last_push_at INTEGER,
  last_pull_at INTEGER,
  last_error_json TEXT
);

-- Drift snapshot column — stores the QBO state at the moment of drift
-- detection so the UI can render local vs QBO without another round-trip.
-- Cleared (set to NULL) when sync_status flips back to 'synced'.
ALTER TABLE invoice ADD COLUMN qbo_pull_snapshot_json TEXT;

-- Drift field paths array (JSON). Populated when sync_status='drift',
-- cleared when resolved.
ALTER TABLE invoice ADD COLUMN drift_fields_json TEXT;
