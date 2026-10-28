-- ExamPilot AI chat images (compressed copies only), in its own free D1 database
-- (binding MEDIA_DB). Never in the learning database. One row per image.
CREATE TABLE IF NOT EXISTS ai_images (
  id          TEXT PRIMARY KEY,               -- random, unguessable (img_…)
  account_id  TEXT NOT NULL,                  -- owner, every read checks it
  conv        TEXT NOT NULL,                  -- AI conversation id (deleted with it)
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
  bytes       INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 600000),
  w           INTEGER NOT NULL,
  h           INTEGER NOT NULL,
  sha         TEXT NOT NULL,                  -- content hash (dedupe inside a conversation)
  data        BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  linked_at   INTEGER                         -- first seen in a synced chat message (else orphan after 24 h)
);
CREATE INDEX IF NOT EXISTS ai_images_owner ON ai_images(account_id, conv);
CREATE INDEX IF NOT EXISTS ai_images_orphans ON ai_images(linked_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ai_images_dedupe ON ai_images(account_id, conv, sha);
