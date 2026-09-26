-- The instance-wide "active space" is gone: nothing reads or writes this row
-- any more, and a space is always addressed explicitly.
DELETE FROM "Setting" WHERE "id" = 'active-space-slug';
