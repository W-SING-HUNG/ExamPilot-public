-- ExamPilot cloud sync — schema v1
-- Every table that holds user data is keyed by account_id; every query in
-- worker/api.ts binds account_id from the VERIFIED identity, never from input.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  epoch       INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  seq         INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  reset_seq   INTEGER NOT NULL DEFAULT 0,
  bank_fp     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'))
);

-- One verified login identity -> one account. Email is the identity Access asserts.
CREATE TABLE IF NOT EXISTS identities (
  provider     TEXT NOT NULL,
  email        TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  sub          TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (provider, email)
);
CREATE INDEX IF NOT EXISTS identities_account ON identities(account_id);

-- Append-only operation log (the source of truth for learning data).
CREATE TABLE IF NOT EXISTS ops (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  seq         INTEGER NOT NULL,
  op_id       TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  epoch       INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_opid ON ops(account_id, op_id);

-- Versioned single-value documents (practice drafts, the running exam).
CREATE TABLE IF NOT EXISTS docs (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  seq         INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  body        TEXT,
  holder      TEXT,
  last_op_id  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS docs_seq ON docs(account_id, seq);

-- Devices that have talked to the account (no fingerprinting; client-generated id).
CREATE TABLE IF NOT EXISTS clients (
  account_id  TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (account_id, client_id)
);

-- Usage counters for quota protection and observability.
CREATE TABLE IF NOT EXISTS usage_daily (
  day         TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  pushes      INTEGER NOT NULL DEFAULT 0,
  ops         INTEGER NOT NULL DEFAULT 0,
  bytes_in    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, account_id)
);

-- Optimistic-concurrency guard: never holds a row. Inserting NULL here raises a
-- NOT NULL error, which aborts (rolls back) the surrounding D1 batch.
CREATE TABLE IF NOT EXISTS occ_guard (
  ok INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');
