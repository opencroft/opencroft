import { describeThreadKeyMigration, migrateThreadSessionKeys } from '@/app/_authed/(group-chats)/_server/model'
import {
  describeOrphanSweep,
  sweepOrphanedSessionKeys,
} from '@/app/_authed/(group-chats)/_server/orphaned-session-keys'

// Stored thread keys move to the dot form here rather than in the database
// package's migrations because the move is not SQL: it carries the durable
// session pointer, the queue and the in-memory registries with each key. Every
// start runs it; once the store holds no colon slug key it moves nothing and
// says nothing.
//
// Not fatal on failure: every thread already in the dot form keeps serving, a
// thread still under a colon key cannot be reached until a start succeeds, and
// the next start tries again. Reports whether it completed.
async function migrateThreadKeys(): Promise<boolean> {
  try {
    const summary = describeThreadKeyMigration(await migrateThreadSessionKeys())
    if (summary) {
      console.log(`[startup] thread keys: ${summary}`)
    }
    return true
  } catch (err) {
    console.error('[startup] thread key migration failed', err)
    return false
  }
}

// Silent when there is nothing to forget. A refusal is logged as an error: it
// means the sweep saw something it does not trust, and a person should look.
async function sweepOrphanedKeys(): Promise<void> {
  try {
    const report = await sweepOrphanedSessionKeys()
    const log = 'refused' in report ? console.error : console.log
    for (const line of describeOrphanSweep(report)) {
      log(`[startup] ${line}`)
    }
  } catch (err) {
    console.error('[startup] orphaned session key sweep failed', err)
  }
}

/**
 * The migration, then the sweep -- and the sweep only if the migration
 * completed. A migration that stopped part-way can leave a thread's state under
 * a key it has not finished moving, and a sweep in that same start would read
 * it as nobody's.
 */
export async function maintainThreadKeys(
  steps: { migrate: () => Promise<boolean>; sweep: () => Promise<void> } = {
    migrate: migrateThreadKeys,
    sweep: sweepOrphanedKeys,
  },
): Promise<void> {
  if (await steps.migrate()) {
    await steps.sweep()
  } else {
    console.error('[startup] orphan sweep skipped: thread-key migration failed this start')
  }
}
