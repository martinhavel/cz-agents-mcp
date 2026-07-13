# Hosted entitlement migration

The additive migration is owned by `src/entitlements/store.ts` and runs idempotent `CREATE TABLE IF NOT EXISTS` statements when `EntitlementStore` starts. It does not alter or delete the existing `tokens` table.

Normal rollback is an application rollback with the new tables left inert. `hosted-entitlements-downgrade.sql` is provided only for an explicitly approved offline destructive cleanup after a verified database backup.
