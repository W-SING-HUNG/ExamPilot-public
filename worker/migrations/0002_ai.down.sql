-- Rollback of 0002_ai.sql: removes only the AI tables. Sync data is untouched.
DROP TABLE IF EXISTS ai_usage_daily;
DROP INDEX IF EXISTS ai_grant_log_account;
DROP TABLE IF EXISTS ai_grant_log;
DROP TABLE IF EXISTS ai_admins;
DROP TABLE IF EXISTS ai_grants;
DELETE FROM schema_meta WHERE key = 'ai_schema';
