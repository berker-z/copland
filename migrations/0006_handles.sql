-- ============================================================================
-- Handles and uploaded pictures, instead of Google's name and photo.
-- ----------------------------------------------------------------------------
-- A person goes by a handle they choose (src/domain/handle.ts): unique,
-- lowercase, a-z 0-9 and "-". Their real name is no longer kept at all, and
-- their picture is one they upload (R2, under avatars/), not Google's.
--
-- Existing accounts get a handle from the part of their email before the @,
-- with "." "_" "+" turned into "-", and a number added when two come out
-- the same. Anything odd that survives can be changed in settings; the
-- rules apply when a handle is set, not to these.
-- ============================================================================

ALTER TABLE users ADD COLUMN handle TEXT NOT NULL DEFAULT '';
-- R2 key of the uploaded picture; null shows initials.
ALTER TABLE users ADD COLUMN avatar_key TEXT;

UPDATE users SET handle = (
  WITH stems AS (
    SELECT id, created_at, rowid AS r,
           trim(substr(lower(replace(replace(replace(substr(email, 1, instr(email, '@') - 1), '.', '-'), '_', '-'), '+', '-')), 1, 28), '-') AS raw
      FROM users
  ),
  safe AS (
    SELECT id, created_at, r,
           CASE WHEN length(raw) < 2
                  OR raw IN ('me', 'myself', 'self', 'none', 'admin', 'admins', 'everyone', 'here', 'someone', 'system', 'copland', 'agent', 'agents')
                THEN 'user-' || raw ELSE raw END AS stem
      FROM stems
  ),
  ranked AS (
    SELECT id, stem, ROW_NUMBER() OVER (PARTITION BY stem ORDER BY created_at, r) AS n FROM safe
  )
  SELECT CASE WHEN n = 1 THEN stem ELSE stem || '-' || n END FROM ranked WHERE ranked.id = users.id
);

CREATE UNIQUE INDEX users_handle ON users(handle);

ALTER TABLE users DROP COLUMN name;
ALTER TABLE users DROP COLUMN picture;
