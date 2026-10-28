-- Separate D1 database for the deletion ledger: restoring the main D1 (Time Travel)
-- cannot roll this one back, so deleted accounts can be re-deleted after a restore.
CREATE TABLE IF NOT EXISTS deletions (
  tag        TEXT PRIMARY KEY,
  account_id TEXT,
  reason     TEXT,
  deleted_at INTEGER NOT NULL
);
