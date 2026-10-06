// Run once per test run, before any test file (see run-tests.mjs). Most suites
// here open the database, and each test process gets a datadir of its own, so
// without this every one of them initialises and migrates an empty database
// itself. With it they start from a copy of one migrated here.
import { buildTemplateDatadir } from '@opencroft/db/test-template'

await buildTemplateDatadir()
