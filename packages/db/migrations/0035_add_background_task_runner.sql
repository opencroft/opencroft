-- Hand-edited: the UPDATE after the generated statement is not drizzle's.
--
-- `runner` says HOW a task runs, apart from what ran. Until now `kind` said
-- both: every `tool` row was a command the background task runner detached
-- on a node, and every other kind a handler in the server's own process. The
-- default files the rows that exist as in-process, which is right for the
-- actions; the UPDATE then moves every `tool` row, running or ended, to the
-- runner -- a running one is still out on its node, and read as in-process it
-- would be failed by the next restart's sweep instead of being probed there.
ALTER TABLE "BackgroundTask" ADD COLUMN "runner" text DEFAULT 'in-process' NOT NULL;--> statement-breakpoint
UPDATE "BackgroundTask" SET "runner" = 'background-task-runner' WHERE "kind" = 'tool';
