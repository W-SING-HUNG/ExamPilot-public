-- Rollback of 0003_platform.sql: drops only the platform tables.
-- Learning data (accounts, identities, ops, docs, clients) and the AI tables are untouched.
-- WARNING: run only after rolling the Worker code back; data in these tables is lost
-- (export first: wrangler d1 export).
DROP TABLE IF EXISTS job_locks;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS deletion_log;
DROP TABLE IF EXISTS mail_outbox;
DROP TABLE IF EXISTS admin_notice_reads;
DROP TABLE IF EXISTS admin_notices;
DROP TABLE IF EXISTS appeals;
DROP TABLE IF EXISTS pro_state;
DROP TABLE IF EXISTS pro_suspensions;
DROP TABLE IF EXISTS pro_grants;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS referral_links;
DROP TABLE IF EXISTS member_tags;
DROP TABLE IF EXISTS member_group_links;
DROP TABLE IF EXISTS member_groups;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS applications;
DROP TABLE IF EXISTS rate_buckets;
DROP TABLE IF EXISTS email_otps;
DROP TABLE IF EXISTS members;
DELETE FROM schema_meta WHERE key = 'platform_schema';
