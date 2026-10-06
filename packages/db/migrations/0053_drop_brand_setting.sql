-- The brand colour is instance configuration (OPENCROFT_BRAND_COLOR), not a
-- stored setting: nothing reads or writes this row any more.
DELETE FROM "Setting" WHERE "id" = 'brand';
