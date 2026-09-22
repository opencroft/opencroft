// One read of the background-task list, as the audit page draws it.
//
// The server function never throws: a list it cannot read comes back with its
// error. The request carrying it can still fail on the way, and that failure
// has to reach the page the same way. Swallowed, as the session poll beside it
// swallows its own, it would leave the card on whatever it drew last -- a list
// nobody can vouch for any more, or "reading" for good -- when the one thing
// the page can honestly say is that the list could not be read.

import type { BackgroundTaskList } from '@/app/_authed/(background-tasks)/_server/task-list'

export async function readBackgroundTasks(read: () => Promise<BackgroundTaskList>): Promise<BackgroundTaskList> {
  try {
    return await read()
  } catch (error) {
    return { tasks: [], error: error instanceof Error ? error.message : String(error) }
  }
}
