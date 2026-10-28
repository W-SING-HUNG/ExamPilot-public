-- ExamPilot platform — schema v3 (additive only; no existing table is altered or dropped)
-- Invitation-only membership, waitlist, two-level admins, Pro entitlement ledger,
-- referrals, in-app admin notifications, mail outbox, lifecycle jobs, audit.
-- Rollback: worker/migrations/0003_platform.down.sql drops exactly these tables.
-- Old code keeps working after this migration: it never reads these tables, and
-- the new code keeps ai_grants / ai_admins in sync as a mirror.

-- One row per e-mail that may (or once could) use the learning site.
-- account_id is filled on the first verified login (accounts row is created then).
CREATE TABLE IF NOT EXISTS members (
  email            TEXT PRIMARY KEY,                       -- normalised (trim + lower)
  account_id       TEXT UNIQUE,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','reviewer','super')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','closing','deleted')),
  source           TEXT NOT NULL DEFAULT 'legacy' CHECK (source IN ('legacy','access','invite','application')),
  created_at       INTEGER NOT NULL,
  activated_at     INTEGER,                                -- first verified login after approval
  last_login_at    INTEGER,                                -- server-observed verified activity
  long_retain      INTEGER NOT NULL DEFAULT 0 CHECK (long_retain IN (0,1)),
  retain_cleared_at INTEGER,                               -- when long_retain was switched off
  status_at        INTEGER,                                -- when status last changed
  delete_after     INTEGER,                                -- set while revoked/closing
  delete_reason    TEXT CHECK (delete_reason IS NULL OR delete_reason IN ('admin_revoke','self_close','inactive')),
  inactive_warned_at INTEGER,
  access_state     TEXT NOT NULL DEFAULT 'ok' CHECK (access_state IN ('ok','pending','failed')),
  access_error     TEXT,
  access_attempts  INTEGER NOT NULL DEFAULT 0,
  note             TEXT,                                   -- internal admin note
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS members_status ON members(status, delete_after);
CREATE INDEX IF NOT EXISTS members_access ON members(access_state);
CREATE INDEX IF NOT EXISTS members_login ON members(last_login_at);

-- E-mail one-time codes (only a salted hash is stored).
CREATE TABLE IF NOT EXISTS email_otps (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('apply','status','invite','restore','close')),
  code_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS email_otps_email ON email_otps(email, purpose, created_at);

-- Fixed-window counters for public endpoints (per hashed key).
CREATE TABLE IF NOT EXISTS rate_buckets (
  key     TEXT NOT NULL,
  win     INTEGER NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, win)
);

-- Waitlist applications.
CREATE TABLE IF NOT EXISTS applications (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  referral_link_id TEXT,
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decided_by       TEXT,
  reject_internal  TEXT,
  reject_public    TEXT,
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_pending ON applications(email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS applications_status ON applications(status, created_at);
CREATE INDEX IF NOT EXISTS applications_email ON applications(email, created_at);

-- Admin invitations (7 days). The token itself is only in the e-mail; we keep its hash.
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER,
  version     INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_one_pending ON invites(email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS invites_status ON invites(status, expires_at);

-- Groups / tags (labels only: never change permissions).
CREATE TABLE IF NOT EXISTS member_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_group_links (
  email     TEXT NOT NULL REFERENCES members(email),
  group_id  TEXT NOT NULL REFERENCES member_groups(id),
  PRIMARY KEY (email, group_id)
);
CREATE TABLE IF NOT EXISTS member_tags (
  email  TEXT NOT NULL REFERENCES members(email),
  tag    TEXT NOT NULL,
  PRIMARY KEY (email, tag)
);

-- Referral links (random token, never derived from the account).
CREATE TABLE IF NOT EXISTS referral_links (
  id          TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS referral_links_owner ON referral_links(owner_email, status);

-- One referral per referee, ever (UNIQUE referee_email): one reward per new user.
CREATE TABLE IF NOT EXISTS referrals (
  id              TEXT PRIMARY KEY,
  referee_email   TEXT NOT NULL UNIQUE,
  referrer_email  TEXT NOT NULL,
  link_id         TEXT NOT NULL,
  application_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'applied'
                  CHECK (status IN ('applied','approved','rejected','rewarded','held','void')),
  flags           TEXT,                     -- JSON list of anomaly reasons (never auto-verdict)
  review          TEXT CHECK (review IS NULL OR review IN ('pending','legit','invalid')),
  reviewed_by     TEXT,
  reviewed_at     INTEGER,
  grant_id        TEXT,
  created_at      INTEGER NOT NULL,
  activated_at    INTEGER,
  version         INTEGER NOT NULL DEFAULT 1,
  CHECK (referee_email <> referrer_email)
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_email, created_at);
CREATE INDEX IF NOT EXISTS referrals_status ON referrals(status, review);

-- Pro entitlement ledger. Rows are never deleted; corrections are new rows
-- (kind='correction') or a revocation stamp on the original.
CREATE TABLE IF NOT EXISTS pro_grants (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('legacy','admin','referral','referral_manual')),
  kind        TEXT NOT NULL CHECK (kind IN ('permanent','days')),
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  starts_at   INTEGER NOT NULL,             -- when it joined the queue
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','held','revoked')),
  revoked_at  INTEGER,
  revoke_note TEXT,
  revoked_unused_ms INTEGER,               -- unused part removed by the revocation
  ref_id      TEXT,                         -- referral id for referral grants
  reason      TEXT,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  idem_key    TEXT UNIQUE                   -- e.g. 'ref:<referral id>' blocks double rewards
);
CREATE INDEX IF NOT EXISTS pro_grants_email ON pro_grants(email, starts_at);

-- Forced suspension of all Pro (super admin).
CREATE TABLE IF NOT EXISTS pro_suspensions (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('freeze','continue')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  started_by  TEXT NOT NULL,
  ended_by    TEXT,
  reason      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pro_suspensions_one_open ON pro_suspensions(email) WHERE ended_at IS NULL;

-- Cached projection of the ledger, rebuilt on every change (used for lists,
-- reminders and the ai_grants mirror; the AI gate recomputes from the ledger).
CREATE TABLE IF NOT EXISTS pro_state (
  email        TEXT PRIMARY KEY,
  tier         TEXT NOT NULL CHECK (tier IN ('standard','pro')),
  permanent    INTEGER NOT NULL DEFAULT 0,
  until        INTEGER,
  until_since  INTEGER,                     -- when `until` took its current value
  paused_ms    INTEGER,                     -- remaining time while frozen
  suspended    INTEGER NOT NULL DEFAULT 0,
  computed_at  INTEGER NOT NULL,
  remind3_for  INTEGER,                     -- the `until` a 3-day reminder was sent for
  remind1_for  INTEGER,
  expired_for  INTEGER                      -- the `until` an expiry notice was sent for
);
CREATE INDEX IF NOT EXISTS pro_state_until ON pro_state(until);

-- One appeal per referral decision.
CREATE TABLE IF NOT EXISTS appeals (
  id           TEXT PRIMARY KEY,
  referral_id  TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','denied')),
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  decision_note TEXT
);

-- In-app notifications for admins (no admin e-mail).
CREATE TABLE IF NOT EXISTS admin_notices (
  id          TEXT PRIMARY KEY,
  audience    TEXT NOT NULL CHECK (audience IN ('reviewer','super')),  -- reviewer = every admin
  kind        TEXT NOT NULL,
  ref         TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  created_at  INTEGER NOT NULL,
  handled_at  INTEGER,
  handled_by  TEXT,
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS admin_notices_open ON admin_notices(audience, handled_at, created_at);
CREATE TABLE IF NOT EXISTS admin_notice_reads (
  notice_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (notice_id, email)
);

-- Outgoing user mail queue (idempotent by dedupe_key).
CREATE TABLE IF NOT EXISTS mail_outbox (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  template    TEXT NOT NULL,
  params      TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','dead','held')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  last_error  TEXT,
  provider_id TEXT,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(status, next_at);

-- Deletion ledger (also mirrored to KV so a D1 restore cannot resurrect data).
CREATE TABLE IF NOT EXISTS deletion_log (
  id          TEXT PRIMARY KEY,
  email_hash  TEXT NOT NULL,
  account_id  TEXT,
  reason      TEXT NOT NULL,
  deleted_at  INTEGER NOT NULL,
  rows        TEXT                          -- JSON counts per table, no content
);
CREATE INDEX IF NOT EXISTS deletion_log_account ON deletion_log(account_id);

-- Audit log (minimal, redacted).
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,                -- email or 'system' / 'public'
  actor_role  TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, at);

-- Site settings (application switch + editable public texts).
CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

-- Short-lived job locks (Access sync, cron).
CREATE TABLE IF NOT EXISTS job_locks (
  name        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  until       INTEGER NOT NULL
);

-- ---------- backfill: existing accounts become members ----------
INSERT OR IGNORE INTO members (email, account_id, role, status, source, created_at, activated_at, last_login_at, status_at)
SELECT i.email, i.account_id,
       CASE WHEN EXISTS (SELECT 1 FROM ai_admins d WHERE d.account_id = i.account_id) THEN 'super' ELSE 'user' END,
       CASE WHEN a.status = 'active' THEN 'active' ELSE 'revoked' END,
       'legacy', a.created_at, a.created_at, i.last_seen_at, a.created_at
  FROM identities i JOIN accounts a ON a.id = i.account_id
 WHERE i.provider = 'cf-access';

-- Existing AI grants become permanent Pro (nothing is lost).
INSERT OR IGNORE INTO pro_grants (id, email, source, kind, duration_ms, starts_at, state, reason, created_by, created_at, idem_key)
SELECT 'pg_legacy_' || g.account_id, i.email, 'legacy', 'permanent', 0, g.updated_at, 'active',
       '迁移：原 AI 权限', 'system', g.updated_at, 'legacy:' || g.account_id
  FROM ai_grants g JOIN identities i ON i.account_id = g.account_id AND i.provider = 'cf-access'
 WHERE g.enabled = 1;

INSERT OR IGNORE INTO site_settings (key, value, updated_at, updated_by) VALUES ('applications_open', '1', 0, 'system');

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('platform_schema', '1');
