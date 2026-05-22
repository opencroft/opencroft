export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { getSpacesRegistry } = await import('@/app/(space)/server/store');
  const registry = getSpacesRegistry();
  await registry.ensureLoaded();
  const count = registry.list().length;
  console.log(`[spaces] preloaded ${count} space${count === 1 ? '' : 's'}`);
  const { startEventScheduler } = await import('@/server/scheduler/event-scheduler');
  startEventScheduler();
  const { startDockerPsPoller } = await import('@/server/scheduler/docker-ps-poller');
  startDockerPsPoller();

  const { autoInstallExtensions } = await import('@/app/(extension-runtime)/_server/registry');
  autoInstallExtensions().catch((err) => {
    console.error('[extensions] auto-install failed:', err);
  });
}
