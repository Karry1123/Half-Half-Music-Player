# Public identity migration

`Accounts.migrate()` runs transactionally on both SQLite and PostgreSQL and is safe to rerun on an existing database. PostgreSQL locks the identity tables during migration; SQLite uses its existing immediate transaction lock.

The migration adds `users.short_id`, backfills unique seven-character IDs from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, and adds a unique index. UUID `users.id` values and all existing foreign-key references stay intact. Registration retries a short-ID collision independently of username conflicts.

The migration adds `profiles.nickname_normalized` and a unique index. Normalization uses Unicode NFKC, collapsed whitespace, trimming, and case folding with JavaScript `toLowerCase()`, consistently for migration and profile saves. For legacy duplicates, the earliest profile by `updated_at`, then `user_id`, keeps its nickname. Later duplicates receive ` (2)`, ` (3)`, etc., shortening the original name to keep the result within sixteen characters. Already existing nicknames are reserved before suffix assignment, so they are never displaced. No accounts, profiles, libraries, or friendships are deleted. Subsequent deployments preserve the resolved names and public IDs.

Profile writes return HTTP 409 with `NICKNAME_TAKEN` and a Chinese error message when another account owns the normalized nickname. Accounts without a saved nickname continue to display their username.
