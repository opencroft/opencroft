import { startDbBackupScheduler } from '@opencroft/db-backups'
import { copyCachedKeys, registerKeyStoreAccess, registerKeyStoreMaterial, ssh } from '@opencroft/terminal/server'

import { registerCompactionHandler, registerSessionOpener } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { migrateInstructionNodes } from '@/app/_authed/(agent)/_server/instruction-node-migration'
import { migrateAgentPlacements } from '@/app/_authed/(agent)/_server/placement-migration'
import { startTranscriptRetention } from '@/app/_authed/(agent)/_server/transcript-retention'
import { watchRoutePaths } from '@/app/_authed/(extension-runtime)/_server/api-route-claims'
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
import { secretNameOf } from '@/app/_authed/(secrets-store)/_lib/secret-values'
import {
  prepareLiveGraphs,
  refreshGraphContexts,
  registerGraphDocType,
} from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { warnOnUnknownBrandColor } from '@/app/_server/brand-color'
import { storeAllCollabDocs } from '@/server/collab/collab-server'
import { registerMarkdownDocType } from '@/server/collab/markdown-docs'
import { prepareInstanceKeys } from '@/server/instance-keys'
import { purgeKeysWithTheirGraphs } from '@/server/key-store-removal'
import { requireKeyStoreOnGraphOf } from '@/server/key-store-scope'
import { removeLegacyCacheFolders } from '@/server/legacy-cache-removal'
import { startBackgroundTaskPoller } from '@/server/scheduler/background-task-poller'
import { startDockerPsPoller } from '@/server/scheduler/docker-ps-poller'
import { startEventScheduler } from '@/server/scheduler/event-scheduler'
import { startIdleSessionReaper } from '@/server/scheduler/idle-session-reaper'
import { startUsageRollupScheduler } from '@/server/scheduler/usage-rollup-scheduler'
import { indexSecretStores, reconcileSecretIndexes } from '@/server/secret-index'
import { purgeSecretsWithTheirGraphs } from '@/server/secret-store-removal'
import { secrets } from '@/server/secrets'
import { endSharedShellsWithTheirNodes } from '@/server/shared-terminal-shells'
import { registerShutdownHandlers, registerShutdownStep } from '@/server/shutdown'
import { KEYSTORE_SECRET_ENV, keyStoreSecretIsSet, sshKeyMaterial } from '@/server/ssh-key-store'
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
  // Before anything can sign a session or encrypt a secret: a key first made
  // on use would skip the check for secrets stored under the legacy key. Not
  // fatal, so a key file that cannot be read fails sign-in and stored secrets
  // with its own error rather than every page.
  try {
    await prepareInstanceKeys()
  } catch (err) {
    console.error('[startup] instance keys could not be prepared', err)
  }
  registerResolvers()
  // Before the schedulers, which write graphs: a live graph is written through
  // its document, and the collaboration server must know what a graph
  // document is first. Open documents are stored before the database closes.
  registerGraphDocType()
  endSharedShellsWithTheirNodes()
  // Before anything can write a secret or a graph: every such write re-derives the key index of the stores it touches.
  indexSecretStores()
  purgeSecretsWithTheirGraphs()
  purgeKeysWithTheirGraphs()
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
  // Agents still placed the way agents ran before terminals (a Docker
  // container by name, or the server itself) move to that place's terminal.
  // Not awaited: listing the terminals asks each Docker host, and an agent not
  // moved here is tried again when it opens a session.
  void migrateAgentPlacements()
    .then((lines) => {
      for (const line of lines) {
        console.log(`[agent-placement] ${line}`)
      }
    })
    .catch((err: unknown) => {
      console.error('[agent-placement] agents could not be moved to their terminals', err)
    })
  // Agent Instruction nodes a graph still holds move into their agents' own
  // instructions. Not awaited: nothing at start reads them, and a node not
  // moved because this failed is moved at the next start.
  void migrateInstructionNodes()
    .then((lines) => {
      for (const line of lines) {
        console.log(`[instruction-nodes] ${line}`)
      }
    })
    .catch((err: unknown) => {
      console.error('[instruction-nodes] Agent Instruction nodes could not be moved into their agents', err)
    })
  // Not awaited: until the stored history settings are read, nothing is
  // trimmed, which is what both settings being off means anyway.
  void startTranscriptRetention().catch((err: unknown) => {
    console.error('[startup] the chat history settings could not be read; nothing is trimmed', err)
  })
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
  // The terminal package dials every SSH connection and holds no secrets: a
  // Server node's password stored as `secret:NAME` is resolved here, at the
  // dial, from the Secrets Stores on the graph of the node the credentials name
  // as their scope. Credentials naming no node resolve no secret.
  ssh.registerPasswordResolver(async (stored, serverNodeId) => {
    if (serverNodeId) {
      return secrets.resolveValue(stored, { nodeId: serverNodeId })
    }
    if (secretNameOf(stored) !== undefined) {
      throw new Error('A password taken from a secret needs the Server node it is stored on, and none was given')
    }
    return stored
  })
  // And a Server node's `keyPath` naming a Key Store key (`<storeId>:<name>`) is
  // read only when the store is on the graph of the node the credentials name
  // as their scope: checked before every read, at a dial and in an extension's
  // `ssh.resolveKey`.
  registerKeyStoreAccess(requireKeyStoreOnGraphOf)
  // Once admitted, a store key is read from the database, and from the store's
  // cache file only when the database does not hold it yet.
  registerKeyStoreMaterial(sshKeyMaterial)
}

/**
 * Copies the keys Key Stores keep in this instance's cache files into the
 * database, where every instance sharing it reads them. The files stay, so an
 * older build on this volume still finds its keys. Not fatal: a key not copied
 * here is still read from its file, and copied when it is. Only stores whose
 * node is on a graph are copied: the keys of one deleted while its keys were
 * only files would otherwise become rows nothing deletes.
 */
async function copyCachedSshKeys(): Promise<void> {
  if (!keyStoreSecretIsSet()) {
    console.error(
      `[startup] ${KEYSTORE_SECRET_ENV} is not set: SSH keys in the database cannot be read, and Key Store cache files are not copied into it`,
    )
    return
  }
  try {
    const registry = getSpacesRegistry()
    await registry.ensureLoaded()
    const { copied, failed } = await copyCachedKeys((storeId) => registry.findByNode(storeId) !== null)
    if (copied > 0 || failed > 0) {
      console.log(`[startup] copied ${copied} Key Store key(s) from cache files into the database; ${failed} failed`)
    }
  } catch (err) {
    console.error('[startup] Key Store cache files could not be copied into the database', err)
  }
}

async function preload(): Promise<void> {
  await copyCachedSshKeys()
  // Logged only when it deleted something, since only the first boot of this build on an
  // older cache directory finds the folders.
  try {
    const removed = await removeLegacyCacheFolders()
    if (removed.length > 0) {
      console.log(`[startup] deleted the legacy dashboard's cache folder(s): ${removed.join(', ')}`)
    }
  } catch (err) {
    // Not fatal: nothing reads the folders, and the next boot tries again.
    console.error("[startup] the legacy dashboard's cache folders could not be deleted", err)
  }
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
  // After the graph documents: an index is written through its graph's document. Logged only when
  // it repaired something, since the ordinary case is that every index is exact.
  try {
    const repaired = await reconcileSecretIndexes()
    if (repaired > 0) {
      console.log(`[startup] brought ${repaired} Secrets Store index(es) to the names their stores hold`)
    }
  } catch (err) {
    // Not fatal: an index stays as it is until the next write to its store or its graph, or the next boot.
    console.error('[startup] Secrets Store indexes could not be checked', err)
  }
  // After the graph documents too: a route's path error is written through its graph's document.
  try {
    await watchRoutePaths()
  } catch (err) {
    console.error('[startup] API Route paths could not be checked', err)
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
  // After the extensions and the Apps: they expose the contexts, and a route can
  // point at an App's handle.
  try {
    await refreshGraphContexts()
  } catch (err) {
    console.error('[startup] graph contexts could not be resolved', err)
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
    // Transcripts recorded before the logs were compacted, rewritten one at a
    // time after the catch-up, so boot work on the table runs one pass at a
    // time. A session reopened before the sweep reaches it is rewritten then.
    try {
      const { rewriteLegacyTranscripts } = await import('@/app/_authed/(agent)/_server/session-event-store')
      const done = await rewriteLegacyTranscripts()
      if (done.sessions > 0 || done.left > 0) {
        console.log(
          `[startup] rewrote ${done.sessions} transcript(s) into the compacted layout: ` +
            `${done.rowsBefore} → ${done.rowsAfter} rows, ${done.bytesBefore} → ${done.bytesAfter} bytes of events; ` +
            `${done.left} still to rewrite`,
        )
      }
    } catch (err) {
      // Not fatal: a transcript not rewritten reads back uncompacted, and its
      // next reopen or the next boot rewrites it.
      console.error('[startup] transcript layout rewrite failed', err)
    }
  })()
}
