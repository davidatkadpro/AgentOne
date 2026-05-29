-- modules/email v0.2.0 — Microsoft 365 (Graph) OAuth connection.
--
-- Single operator-level connection row (single row, enforced by CHECK
-- (id = 1)) holding the encrypted OAuth tokens for the GraphEmailSource.
-- Mirrors invoicing's qbo_connection: tokens are DPAPI-encrypted on Windows,
-- AES-GCM elsewhere, stored as BLOBs so we never deal in utf-8 surrogate
-- halves. Tokens never appear in logs, audit rows, or events — only the
-- account display name / email are surfaceable.

CREATE TABLE m365_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_name TEXT,                          -- displayName from /me (nullable)
  account_email TEXT,                         -- mail or userPrincipalName (nullable)
  access_token_encrypted BLOB NOT NULL,
  refresh_token_encrypted BLOB NOT NULL,
  -- Access token expiry (ms epoch); the refresh token is renewed on use.
  token_expires_at INTEGER NOT NULL,
  connected_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  last_error_json TEXT
);
