-- fix5 0004: request-bound idempotency for admin Pro grants (additive, safe to re-run).
-- One row per admin idempotency key: the fingerprint of the request it first carried.
-- A replay with the same key and the same request changes nothing; the same key with a
-- different request is refused (409 idem_conflict). Written in the SAME D1 batch
-- (one transaction) as the grant row, so a concurrent duplicate can never add a second grant.
CREATE TABLE IF NOT EXISTS admin_idem (
  key         TEXT PRIMARY KEY,             -- 'adm:<client key>' (same value as pro_grants.idem_key)
  fp          TEXT NOT NULL,                -- sha256 of the canonical request (email, action, kind, days/until, source, reason)
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
