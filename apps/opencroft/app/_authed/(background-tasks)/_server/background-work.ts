import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'

/**
 * Session keys with work still going on behind them: the `background` set
 * every session status is derived from (see deriveSessionStatus), built here
 * and nowhere else, so the chat lists, the audit page and the idle reaper
 * cannot disagree about which sessions are working.
 *
 * Two halves. The engine reports what the sessions it holds are running — a
 * harness's own tasks and subagents, and this host's tasks once they are in a
 * session. The registry adds every key with a task of this host's still
 * running, which is the half that covers a session nobody has in memory:
 * unloaded, or not reopened since a restart that its task ran through.
 */
export function backgroundWorkSessionKeys(): Set<string> {
  const keys = new Set(agentClient.backgroundWorkSessionKeys())
  for (const key of backgroundTasks.runningSessionKeys()) {
    keys.add(key)
  }
  return keys
}
