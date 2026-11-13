-- The legacy dashboard is gone: nothing reads or writes its canvas, its custom
-- node templates or its Application nodes' rows.
DELETE FROM "Setting"
WHERE "id" IN ('app-dashboard-graph', 'custom-node-templates')
   OR "id" LIKE 'app-node:%';
