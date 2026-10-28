-- ExamPilot web AI — schema v2 (additive only; no existing table is altered)
-- Rollback: worker/migrations/0002_ai.down.sql drops exactly these tables.

-- Per-account AI permission. No row = no AI (default deny).
CREATE TABLE IF NOT EXISTS ai_grants (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- Who may change AI permissions. Rows are inserted only through the Cloudflare
-- D1 console / wrangler (a trusted admin channel), never by the web app.
CREATE TABLE IF NOT EXISTS ai_admins (
  account_id  TEXT PRIMARY KEY REFERENCES accounts(id),
  created_at  INTEGER NOT NULL,
  note        TEXT
);

-- Audit trail of permission changes.
CREATE TABLE IF NOT EXISTS ai_grant_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  enabled     INTEGER NOT NULL,
  by_account  TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_grant_log_account ON ai_grant_log(account_id, at);

-- Call counts for troubleshooting only (never used to limit anyone).
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day         TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  failures    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, account_id)
);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('ai_schema', '1');
