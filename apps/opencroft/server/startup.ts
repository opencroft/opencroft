import { startDbBackupScheduler } from '@opencroft/db-backups'

import { registerCompactionHandler, registerSessionOpener } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  registerSessionWakeResolver,
  registerStandingContextResolver,
  registerThreadDeliveryResolver,
  restoreAfterCompaction,
  wakeSessionByKey,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import {
  deliverThreadFromNode,
  groupChatStandingContext,
  groupChatWakeSession,
} from '@/app/_authed/(group-chats)/_server/model'
import { prepareLiveGraphs, registerGraphDocType } from '@/app/_authed/(space)/_server/graph-collab'
import { warnOnUnknownBrandColor } from '@/app/_server/brand-color'
import { storeAllCollabDocs } from '@/server/collab/collab-server'
import { registerMarkdownDocType } from '@/server/collab/markdown-docs'
import { startBackgroundTaskPoller } from '@/server/scheduler/background-task-poller'
import { startDockerPsPoller } from '@/server/scheduler/docker-ps-poller'
import { startEventScheduler } from '@/server/scheduler/event-scheduler'
import { startIdleSessionReaper } from '@/server/scheduler/idle-session-reaper'
import { startUsageRollupScheduler } from '@/server/scheduler/usage-rollup-scheduler'
import { registerShutdownHandlers, registerShutdownStep } from '@/server/shutdown'
import { maintainThreadKeys } from '@/server/thread-key-maintenance'

const globalForStartup = globalThis as unknown as { __opencroftReady?: Promise<void> }

/**
 * Server-side boot tasks. Runs once per process from a server-only entry point (the SSE route handler), in the same
 * module context that serves docker snapshots. Idempotent.
 *
 * Resolves once the server may serve requests: the thread-key migration and the
 * orphaned-key sweep below have run. The app's request entry and the extension
 * HTTP routes await it, so neither can look up a thread while its key is being
 * moved or classified.
 */
export function ensureServerStarted(): Promise<void> {
  globalForStartup.__opencroftReady ??= start()
  return globalForStartup.__opencroftReady
}

async function start(): Promise<void> {
  warnOnUnknownBrandColor()
  // Before the schedulers, so nothing can start writing into a process that has
  // no way to release the database when it is asked to stop.
  registerShutdownHandlers()
  registerResolvers()
  // Before the schedulers, which write graphs: a live graph is written through
  // its document, and the collaboration server must know what a graph
  // document is first. Open documents are stored before the database closes.
  registerGraphDocType()
  // Markdown documents too, before an extension registers where its own are
  // stored.
  registerMarkdownDocType()
  registerShutdownStep(storeAllCollabDocs)
  // Before the schedulers too: a fired event can drive a send into a thread,
  // and the background-task poller and the idle reaper address sessions by key.
  await maintainThreadKeys()
  // Before anything can read an extension folder: an install a killed process
  // left half done is finished or undone here.
  try {
    const { sweepInstallDebris } = await import('@/app/_authed/(extension-runtime)/_server/install')
    await sweepInstallDebris()
  } catch (err) {
    console.error('[startup] extension install recovery failed', err)
  }
  startEventScheduler()
  startDockerPsPoller()
  startDbBackupScheduler()
  startIdleSessionReaper()
  startBackgroundTaskPoller()
  startUsageRollupScheduler()
  void preload()
}

function registerResolvers(): void {
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
  // requestCompact can resume a group-chat thread without stream.ts
  // ever importing group-chat code.
  registerSessionWakeResolver(groupChatWakeSession)
  // And once more, in the other direction: the agent client holds the delivery
  // gate and, on a wake, finds keys whose session this process does not have.
  // It cannot import the session layer to open them — stream.ts imports the
  // client — so the opener is handed to it here, the one place that already
  // names both sides.
  registerSessionOpener(wakeSessionByKey)
  // And the reverse of the standing-context registration above: when a
  // harness reports its OWN compaction (auto-compaction on a full context, a
  // reader's /compact typed in chat), the client's hook hands it to stream.ts
  // to re-deliver the standing context the compaction just dropped — the same
  // restore the Compact button's job performs, now driven by the event.
  registerCompactionHandler(restoreAfterCompaction)
}

async function preload(): Promise<void> {
  try {
    const { getSpacesRegistry } = await import('@/app/_authed/(space)/_server/store')
    await getSpacesRegistry().ensureLoaded()
  } catch (err) {
    console.error('[startup] spaces preload failed', err)
  }
  // After the spaces preload: every graph's document is brought in step with
  // its stored JSON, and the registry with any edits recorded in a document
  // after its last snapshot.
  try {
    await prepareLiveGraphs()
  } catch (err) {
    console.error('[startup] graph documents could not be prepared', err)
  }
  try {
    const { autoInstallExtensions } = await import('@/app/_authed/(extension-runtime)/_server/install')
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
  // Transcripts the search index has not caught up with: history recorded
  // before it existed, and replies a stopped process left open. In the
  // background, because on the first boot it reads every recorded transcript
  // (kind and text only) and nothing about starting up waits on search.
  void (async () => {
    try {
      const { catchUpTranscriptIndex } = await import('@/app/_authed/(agent)/_server/session-event-store')
      const { sessions } = await catchUpTranscriptIndex()
      if (sessions > 0) {
        console.log(`[startup] indexed ${sessions} transcript(s) for search`)
      }
    } catch (err) {
      // Not fatal: a transcript not caught up is missing from search results,
      // and its next batch or the next boot catches it up.
      console.error('[startup] transcript search backfill failed', err)
    }
  })()
}
