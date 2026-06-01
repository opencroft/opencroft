import { startDockerPsPoller } from '@/server/scheduler/docker-ps-poller';
import { startEventScheduler } from '@/server/scheduler/event-scheduler';

const globalForStartup = globalThis as unknown as { __opencroftStarted?: boolean };

/**
 * Server-side boot tasks (formerly Next.js instrumentation register()). Runs once
 * per process from a server-only entry point (the SSE route handler), in the same
 * module context that serves docker snapshots. Idempotent.
 */
export function ensureServerStarted(): void {
  if (globalForStartup.__opencroftStarted) {
    return;
  }
  globalForStartup.__opencroftStarted = true;

  startEventScheduler();
  startDockerPsPoller();
  void preload();
}

async function preload(): Promise<void> {
  try {
    const { getSpacesRegistry } = await import('@/app/(space)/server/store');
    await getSpacesRegistry().ensureLoaded();
  } catch (err) {
    console.error('[startup] spaces preload failed', err);
  }
  try {
    const { autoInstallExtensions } = await import('@/app/(extension-runtime)/_server/registry');
    await autoInstallExtensions();
  } catch (err) {
    console.error('[startup] extension auto-install failed', err);
  }
}
