import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The marker directory is resolved when the module loads, so the env var is
// set before the import below — same pattern as caller.test.ts.
process.env.OPENCROFT_DATA_DIR = mkdtempSync(join(tmpdir(), 'sleep-mode-test-'))

const { getSleepModeInfo, isSleepMode, resetSleepModeCache, setSleepMode, SLEEP_MARKER_PATH, subscribeSleepMode } =
  await import('./sleep-mode')

test('starts awake, sleeps on set, and the flag is the FILE — a cache reset re-reads it', () => {
  resetSleepModeCache()
  assert.equal(isSleepMode(), false)
  setSleepMode(true)
  assert.equal(isSleepMode(), true)
  assert.ok(existsSync(SLEEP_MARKER_PATH), 'the flag persists as a marker on the data volume')
  // The nearest a unit test gets to a restart: drop the file cache and ask
  // again. The answer must come back from disk.
  resetSleepModeCache()
  assert.equal(isSleepMode(), true, 'a fresh read finds the instance still asleep')
  setSleepMode(false)
  assert.equal(existsSync(SLEEP_MARKER_PATH), false, 'waking removes the marker')
})

test('subscribers hear each transition once, with the new value', () => {
  resetSleepModeCache()
  isSleepMode()
  const heard: boolean[] = []
  const unsubscribe = subscribeSleepMode((enabled) => heard.push(enabled))
  setSleepMode(true)
  setSleepMode(true)
  setSleepMode(false)
  unsubscribe()
  setSleepMode(true)
  setSleepMode(false)
  assert.deepEqual(heard, [true, false], 'repeat writes are not transitions, and unsubscribe sticks')
})

test('an out-of-band marker removal is noticed on the next read and notifies', () => {
  resetSleepModeCache()
  setSleepMode(true)
  assert.equal(isSleepMode(), true)
  const heard: boolean[] = []
  const unsubscribe = subscribeSleepMode((enabled) => heard.push(enabled))
  // Someone removes the file from outside the app (the documented incident
  // path). No in-process call announces it — the next read must.
  rmSync(SLEEP_MARKER_PATH, { force: true })
  resetSleepModeCache()
  assert.equal(isSleepMode(), false)
  assert.deepEqual(heard, [false], 'the wake was detected from the read, not from a setter')
  unsubscribe()
})

test('getSleepModeInfo names where the flag lives', () => {
  resetSleepModeCache()
  const info = getSleepModeInfo()
  assert.equal(info.enabled, false)
  assert.equal(info.markerPath, SLEEP_MARKER_PATH)
})
