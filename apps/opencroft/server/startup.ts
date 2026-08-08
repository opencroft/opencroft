import { startDbBackupScheduler } from '@opencroft/db-backups'

import {
  registerStandingContextResolver,
  registerThreadDeliveryResolver,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { deliverThreadFromNode, groupChatStandingContext } from '@/app/_authed/(group-chats)/_server/model'
import { startDockerPsPoller } from '@/server/scheduler/docker-ps-poller'
import { startEventScheduler } from '@/server/scheduler/event-scheduler'

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

  startEventScheduler()
  startDockerPsPoller()
  startDbBackupScheduler()
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
