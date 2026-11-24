# Token storage F1: additive metadata only

F1 adds nullable `token_id`, `token_hmac`, `hmac_key_id`, `token_prefix`,
`tenant_key` and `outbound_ct` columns. Existing Bearers, plaintext lookup,
quotas, revocations, checkout retrieval and response contracts remain in use.
This change does **not** remove plaintext or switch authentication readers.

Set `CZ_AGENTS_TOKEN_F1=1` only as part of a coordinated writer rollout.
New mints then write the original token plus a stable UUID, HMAC-SHA256 and
key version in the same INSERT. The HMAC domain is the UTF-8 string
`cz-agents-api-token:v1` followed by a NUL byte, then the exact UTF-8 token.
No token normalization is performed.
Only a normal generated 48-character bearer gets a 12-character display prefix.
Legacy/nonstandard bearers have an empty display field so it cannot echo the
complete credential. An intentional empty field is distinct from missing NULL metadata.

Configuration:

- `CZ_AGENTS_TOKEN_HMAC_PEPPER`: exactly 32 random bytes, canonical base64;
- `CZ_AGENTS_TOKEN_HMAC_KEY_ID`: 1–64 ASCII letters, digits, dots, `_` or `-`;
- `CZ_AGENTS_TOKEN_F1`: `0`/unset for the existing writer or `1` for dual write.

When F1 is enabled, missing or invalid HMAC configuration rejects a new mint
before insertion. It never silently writes a plaintext-only replacement.
The escrow key belongs to the webapp writer, not this package. MCP does not
create ciphertext; if an MCP mint creates a DD/DD+ row, the webapp backfill
must fill its envelope before the next migration gate can pass.

The webapp owns the bounded backfill and DD/DD+ AEAD envelope. All affected
writers must be inventoried and upgraded before backfill. A legacy writer can
leave missing or stale metadata; a zero count once is insufficient. G1 requires
zero applicable missing fields, verified digest consistency, a repeated check
after 24 hours and exact image/package provenance for every database mount.
The 24-hour repeat must return both `updated: 0` and `missing: 0`. A successful
repair with `updated > 0` fails G1: identify the missed writer and restart the
observation window. CLI exit code zero alone is never a G1 attestation.
Keep the currently locked pro consumer pinned during F1; a later reader
cutover requires its own coordinated package release.

Rollback during F1 means reverting application code while retaining additive
columns and current database state. Do not restore an old snapshot over new
quota, purchase or revocation data. F2 readers, plaintext removal, schema
rebuild, dashboard show-once and key rotation are outside this PR.
