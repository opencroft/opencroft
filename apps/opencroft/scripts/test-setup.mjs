// Preloaded before every test file in this workspace (see run-tests.mjs's
// --import hook). A backstop for suites that never got around to isolating
// themselves: without it, a forgotten PGLITE_PATH plus an ambient
// DATABASE_URL sends the database code straight at whatever real Postgres
// server the shell happens to be pointed at. See @opencroft/db's test-env
// for what this actually does.
import '@opencroft/db/test-env'
