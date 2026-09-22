// Drives the background-task service: every tick it probes the nodes running
// tasks, times out the ones past their deadline, tells sessions about tasks
// that ended, and tidies up after old ones. Once, at startup, it fails the
// in-process tasks a previous process left marked running.
//
// Ten seconds between ticks. What it buys is how soon an agent hears that its
// build finished, and what it costs is one exec per target that has a task
// running — six a minute to a node that is busy anyway, nothing to one that is
// not. The idle reaper's minute would leave an agent waiting on a result that
// is already there; much faster would be probing work measured in minutes.
//
// The steps are not awaited in turn. A node can take the whole exec cap to
// answer, and a delivery can stay pending as long as delivery is asleep; the
// service keeps each from starting twice, so none of them holds up the others
// or the next tick.

import { type BackgroundTasks, backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'

const TICK_MS = 10_000

type Step = 'probe' | 'deadlines' | 'delivery' | 'housekeeping' | 'startup sweep'

const globalForPoller = globalThis as unknown as {
  __BACKGROUND_TASK_POLLER__?: { timer: NodeJS.Timeout }
  __backgroundTaskPollerFailing?: Set<Step>
}
if (!globalForPoller.__backgroundTaskPollerFailing) {
  globalForPoller.__backgroundTaskPollerFailing = new Set()
}
const failing = globalForPoller.__backgroundTaskPollerFailing

/**
 * Run one step and report how it went, never by throwing. A step that keeps
 * failing — the table not there yet, after a deploy the database has not
 * caught up with — is logged when it starts failing and when it recovers, not
 * every ten seconds in between.
 */
export async function runStep(step: Step, work: () => Promise<void>): Promise<void> {
  try {
    await work()
    if (failing.delete(step)) {
      console.log(`[background-task-poller] ${step} works again`)
    }
  } catch (error) {
    if (!failing.has(step)) {
      failing.add(step)
      console.error(`[background-task-poller] ${step} failed`, error)
    }
  }
}

export function tick(service: BackgroundTasks = backgroundTasks): void {
  void runStep('probe', () => service.probe())
  void runStep('deadlines', () => service.enforceDeadlines())
  void runStep('delivery', () => service.deliverOwed())
  void runStep('housekeeping', () => service.housekeep())
}

export function startBackgroundTaskPoller(): void {
  if (globalForPoller.__BACKGROUND_TASK_POLLER__) {
    return
  }
  void runStep('startup sweep', () => backgroundTasks.sweepOrphans())
  // Early, so the first activity poll after a restart already counts the
  // sessions whose node tasks carried on through it.
  backgroundTasks.loadRunningKeys()
  const timer = setInterval(() => tick(), TICK_MS)
  globalForPoller.__BACKGROUND_TASK_POLLER__ = { timer }
  console.log(`[background-task-poller] started (tick every ${TICK_MS}ms)`)
}
