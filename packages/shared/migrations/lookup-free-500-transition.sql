-- MAR-133 WP6: lower the free lookup allowance of EXISTING registered identities 2000 -> 500.
-- Run only AFTER the ladder code is deployed (HOSTED_QUOTA_LADDER=1); with the flag off the
-- code still treats a 500 row as 2000, so this is safe to run early but has no effect then.
-- Preconditions: verified backup of TOKEN_DB and explicit operator approval.
-- Parameter :T0 = cutoff, epoch milliseconds (tokens.created_at is Date.now()).
--   sqlite3 TOKEN_DB ".parameter set :T0 <epoch_ms>" ".read lookup-free-500-transition.sql"
-- Preview:  SELECT COUNT(*) FROM tokens WHERE service='identity' AND monthly_quota=2000 AND created_at < :T0;
-- Counters, periods, purchases and reservations are NOT touched.
BEGIN IMMEDIATE;
UPDATE tokens SET monthly_quota = 500
 WHERE service = 'identity' AND monthly_quota = 2000 AND created_at < :T0;
COMMIT;
