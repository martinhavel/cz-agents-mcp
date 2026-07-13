-- OPTIONAL DESTRUCTIVE DOWNGRADE — never run during normal application rollback.
-- Preconditions: HOSTED_GEO_TIER_ENFORCEMENT=off, all hosted processes stopped,
-- verified backup of TOKEN_DB, and explicit operator approval.
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS entitlement_policy_audit;
DROP TABLE IF EXISTS entitlement_events;
DROP TABLE IF EXISTS entitlement_usage;
DROP TABLE IF EXISTS account_country_overrides;
DROP TABLE IF EXISTS account_entitlements;
DROP TABLE IF EXISTS country_policies;
DROP TABLE IF EXISTS entitlement_policy_meta;
COMMIT;
