-- Admins used to be whoever was listed in the ADMIN_EMAILS var, as well as
-- anyone with is_admin set. Now is_admin is the only source. Users created
-- through the list already have the column set; this covers an instance
-- where that somehow is not so, by making its oldest account the admin.
-- It does nothing where any admin exists, so it is safe to run anywhere.
UPDATE users SET is_admin = 1
WHERE id = (SELECT id FROM users WHERE disabled_at IS NULL ORDER BY created_at, rowid LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1 AND disabled_at IS NULL);
