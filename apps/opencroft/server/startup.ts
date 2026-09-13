import { startDbBackupScheduler } from '@opencroft/db-backups'

import { registerSessionOpener } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  registerSessionWakeResolver,
  registerStandingContextResolver,
  registerThreadDeliveryResolver,
  wakeSessionByKey,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import {
  deliverThreadFromNode,
  groupChatStandingContext,
  groupChatWakeSession,
} from '@/app/_authed/(group-chats)/_server/model'
import { startDockerPsPoller } from '@/server/scheduler/docker-ps-poller'
import { startEventScheduler } from '@/server/scheduler/event-scheduler'
import { startIdleSessionReaper } from '@/server/scheduler/idle-session-reaper'
import { startUsageRollupScheduler } from '@/server/scheduler/usage-rollup-scheduler'
import { registerShutdownHandlers } from '@/server/shutdown'

const globalForStartup = globalThis as unknown as { __opencroftStarted?: boolean }

/**
 * Server-side boot tasks (formerly Next.js instrumentation register()). Runs once
 * per process from a server-only entry point (the SSE route handler), in the same
 * module context that serves docker snapshots. Idempotent.
 */
export function ensureServerStarted(): void {
  if (globalForStartup.__opencroftStarted) {
    return
  }
  globalForStartup.__opencroftStarted = true

  // Before the schedulers, so nothing can start writing into a process that has
  // no way to release the database when it is asked to stop.
  registerShutdownHandlers()
  startEventScheduler()
  startDockerPsPoller()
  startDbBackupScheduler()
  startIdleSessionReaper()
  startUsageRollupScheduler()
  // The session layer (extension-runtime/_server/stream.ts) knows nothing of
  // group chats — this is the one place that names both, so compaction's
  // restore step can reach a group-chat thread's current topic + pins
  // without stream.ts importing group-chat code (see registerStandingContextResolver's
  // own header for why that matters).
  registerStandingContextResolver(groupChatStandingContext)
  // Same reasoning, for send-message's `thread` envelope field: a
  // graph-driven send can target a group-chat thread without stream.ts ever
  // importing group-chat code.
  registerThreadDeliveryResolver(deliverThreadFromNode)
  // Same reasoning again, for waking an offline thread ahead of a compact —
  // requestCompactOnGraph can resume a group-chat thread without stream.ts
  // ever importing group-chat code.
  registerSessionWakeResolver(groupChatWakeSession)
  // And once more, in the other direction: the agent client holds the delivery
  // gate and, on a wake, finds keys whose session this process does not have.
  // It cannot import the session layer to open them — stream.ts imports the
  // client — so the opener is handed to it here, the one place that already
  // names both sides.
  registerSessionOpener(wakeSessionByKey)
  void preload()
}

async function preload(): Promise<void> {
  try {
    const { getSpacesRegistry } = await import('@/app/_authed/(space)/_server/store')
    await getSpacesRegistry().ensureLoaded()
  } catch (err) {
    console.error('[startup] spaces preload failed', err)
  }
  try {
    const { autoInstallExtensions } = await import('@/app/_authed/(extension-runtime)/_server/registry')
    await autoInstallExtensions()
  } catch (err) {
    console.error('[startup] extension auto-install failed', err)
  }
  // After the spaces preload (an instance context names its space's slug) and
  // after auto-install (the hooks live in extension server modules).
  try {
    const { startSpaceApps } = await import('@/app/_authed/(apps)/_server/runtime')
    await startSpaceApps()
  } catch (err) {
    console.error('[startup] space apps load failed', err)
  }
  // Every account of either kind gets a username here, and it must run AFTER
  // the spaces preload above: an agent is a node in a space graph, so the
  // registry has to be loaded before this can see one to give a handle to.
  //
  // A reconciliation rather than a migration, because agents are created by
  // editing a graph and there is no account-creation path to hook — so this
  // is how "every account has a handle" becomes true again for one made since
  // the last boot. Logged only when it did work, since the ordinary case is
  // that it has nothing to do.
  try {
    const { ensureUsernames } = await import('@/app/_server/usernames')
    const { assigned, failed } = await ensureUsernames()
    if (assigned > 0) {
      console.log(`[startup] assigned ${assigned} username(s)`)
    }
    if (failed > 0) {
      // Said separately and loudly: these accounts came out of the pass with
      // no handle, which is the one thing this step exists to prevent. A
      // silent zero-assigned would read as "nothing to do".
      console.error(`[startup] ${failed} account(s) could not be given a username`)
    }
  } catch (err) {
    // Not fatal: an account without a handle renders unresolved, which is a
    // designed state, and the next boot tries again.
    console.error('[startup] username backfill failed', err)
  }
  // Deliberately NOT try/caught like the steps above: a type-id collision
  // between two installed extensions means one of them cannot actually work
  // (something owns the type; the other's declaration is dead), and letting
  // the server come up anyway would serve that broken state as if it were
  // fine. This is meant to fail the boot, loudly, not log and continue.
  await assertNodeTypeIdsUniqueAtBoot()
}

async function assertNodeTypeIdsUniqueAtBoot(): Promise<void> {
  const { loadAllManifests } = await import('@/app/_authed/(extension-runtime)/_server/loader')
  const { assertUniqueNodeTypeIds, manifestOwners } = await import('@/app/_authed/(extension-runtime)/_node-type-guard')
  const manifests = await loadAllManifests()
  assertUniqueNodeTypeIds(manifestOwners(manifests))
}
