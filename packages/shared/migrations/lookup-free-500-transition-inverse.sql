-- MAR-133 WP6 INVERSE: restore free lookup allowance 500 -> 2000 for identities created before :T0.
-- Use the SAME :T0 as the forward run. Rows that were 500 before the forward run and created
-- before :T0 (none are expected to exist) would also be changed; verify with the preview.
-- Preview:  SELECT COUNT(*) FROM tokens WHERE service='identity' AND monthly_quota=500 AND created_at < :T0;
-- Preconditions: verified backup of TOKEN_DB and explicit operator approval.
BEGIN IMMEDIATE;
UPDATE tokens SET monthly_quota = 2000
 WHERE service = 'identity' AND monthly_quota = 500 AND created_at < :T0;
COMMIT;
