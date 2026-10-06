-- Graphs always sync through their documents: nothing reads or writes the
-- graph sync mode row any more.
DELETE FROM "Setting" WHERE "id" = 'graph-sync';
