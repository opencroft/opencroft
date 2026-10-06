// Preloaded by run-tests.mjs, ahead of tsx, when run-workspace-tests.mjs hands
// it a slot pool (OPENCROFT_TEST_SLOTS). The test runner passes its preloads
// to each file's process and runs none itself, so this runs once per test
// file. The file waits here for a slot before anything else loads, and holds
// it until it exits: the open connection is the slot, so the pool gets it back
// however the process ends.
//
// The pool is taken out of the environment once the slot is held, so a process
// the test itself starts does not queue behind the file that started it.

import { connect } from 'node:net'

const pool = process.env.OPENCROFT_TEST_SLOTS
if (pool) {
  delete process.env.OPENCROFT_TEST_SLOTS
  await new Promise((resolve, reject) => {
    const slot = connect(pool)
    slot.once('data', () => {
      // Held open without keeping the process alive.
      slot.unref()
      resolve()
    })
    slot.once('error', (error) => reject(new Error(`no test slot from ${pool}: ${error.message}`)))
  })
}
