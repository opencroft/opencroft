import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { DockerContainerSnapshot } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'

const TICK_MS = 10_000

// A host that fails is backed off exponentially (30s, 1m, 2m, 4m, ... capped at 10m) instead of
// being retried every tick forever — a host that has been down for days would otherwise still be
// polled, and fail, every 10 seconds.
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 10 * 60_000

interface GraphNode {
  id?: string
  type?: string
}

export interface HostFailureState {
  consecutiveFailures: number
  nextAttemptAt: number
}

interface PollerState {
  lastSnapshot: Map<string, DockerContainerSnapshot[]>
  inFlight: Set<string>
  failures: Map<string, HostFailureState>
}

const g = globalThis as Record<string, unknown>
if (!g.__DOCKER_PS_STATE__) {
  g.__DOCKER_PS_STATE__ = {
    lastSnapshot: new Map<string, DockerContainerSnapshot[]>(),
    inFlight: new Set<string>(),
    failures: new Map<string, HostFailureState>(),
  } satisfies PollerState
}
const state = g.__DOCKER_PS_STATE__ as PollerState
const lastSnapshot = state.lastSnapshot
const inFlight = state.inFlight
const failures = state.failures

export function backoffMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1))
}

// Pure state transition for one host's poll outcome — no globals, no I/O, so the backoff
// progression and the log-on-transition-only behavior are unit-testable without mocking the
// extension loader / spaces registry / toast store this module otherwise depends on.
// `transitioned` is true only on failing<->reachable edges, which is exactly when pollOne should
// log — every other tick for an already-known-good or already-known-bad host logs nothing.
export function nextFailureState(
  current: HostFailureState | undefined,
  outcome: 'ok' | 'error',
  now: number,
): { next: HostFailureState | undefined; transitioned: boolean } {
  if (outcome === 'ok') {
    return { next: undefined, transitioned: current !== undefined }
  }
  const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1
  return {
    next: { consecutiveFailures, nextAttemptAt: now + backoffMs(consecutiveFailures) },
    transitioned: consecutiveFailures === 1,
  }
}

// A host currently inside its backoff window is not due for another attempt yet.
export function isDue(current: HostFailureState | undefined, now: number): boolean {
  return (current?.nextAttemptAt ?? 0) <= now
}

function collectDockerNodeIds(): string[] {
  const r = getSpacesRegistry()
  const ids: string[] = []
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const spaceNodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes)
    for (const node of spaceNodes as unknown as GraphNode[]) {
      if (node.type !== 'docker' || !node.id) {
        continue
      }
      ids.push(node.id)
    }
  }
  return ids
}

function containersEqual(a: DockerContainerSnapshot[], b: DockerContainerSnapshot[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.service !== y.service ||
      x.status !== y.status ||
      x.running !== y.running
    ) {
      return false
    }
  }
  return true
}

function sortContainers(list: DockerContainerSnapshot[]): DockerContainerSnapshot[] {
  return [...list].sort((a, b) => a.id.localeCompare(b.id))
}

// Resolve whichever extension currently declares the "docker" node typeId, the same way
// node-actions.ts does for dispatched node actions — the docker extension isn't guaranteed to be
// installed under the literal slug "docker" (e.g. an asLocal install can land under a different
// slug, such as "opencroft-docker", giving it the id "local/opencroft-docker").
async function callDockerPs(dockerNodeId: string): Promise<DockerContainerSnapshot[]> {
  const manifests = await loadAllManifests()
  const owning = manifests.find((m) => m.nodes?.some((n) => n.typeId === 'docker'))
  if (!owning) {
    return []
  }
  const mod = await getExtensionModule(owning.id)
  const fn = mod.actions['docker.ps']
  if (!fn) {
    return []
  }
  const result = await fn({ dockerNodeId })
  return result as DockerContainerSnapshot[]
}

async function pollOne(dockerNodeId: string): Promise<void> {
  if (inFlight.has(dockerNodeId)) {
    return
  }
  inFlight.add(dockerNodeId)
  try {
    const fresh = sortContainers(await callDockerPs(dockerNodeId))
    const { next, transitioned } = nextFailureState(failures.get(dockerNodeId), 'ok', Date.now())
    if (next) {
      failures.set(dockerNodeId, next)
    } else {
      failures.delete(dockerNodeId)
    }
    if (transitioned) {
      console.log(`[docker-ps-poller] ${dockerNodeId} reachable again`)
    }
    const prev = lastSnapshot.get(dockerNodeId)
    if (prev && containersEqual(prev, fresh)) {
      return
    }
    lastSnapshot.set(dockerNodeId, fresh)
    toastStore.broadcast({ type: 'docker_ps_updated', dockerNodeId, containers: fresh })
  } catch (err) {
    const { next, transitioned } = nextFailureState(failures.get(dockerNodeId), 'error', Date.now())
    if (next) {
      failures.set(dockerNodeId, next)
    }
    if (transitioned) {
      console.error(`[docker-ps-poller] ${dockerNodeId} unreachable, backing off:`, err)
    }
  } finally {
    inFlight.delete(dockerNodeId)
  }
}

async function tick(): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const ids = collectDockerNodeIds()
  const known = new Set(ids)
  for (const id of [...lastSnapshot.keys()]) {
    if (!known.has(id)) {
      lastSnapshot.delete(id)
    }
  }
  for (const id of [...failures.keys()]) {
    if (!known.has(id)) {
      failures.delete(id)
    }
  }
  const now = Date.now()
  const due = ids.filter((id) => isDue(failures.get(id), now))
  await Promise.all(due.map(pollOne))
}

export function getAllDockerSnapshots(): { dockerNodeId: string; containers: DockerContainerSnapshot[] }[] {
  return [...lastSnapshot.entries()].map(([dockerNodeId, containers]) => ({ dockerNodeId, containers }))
}

function refreshDockerNode(dockerNodeId: string): void {
  // An explicit invalidation (e.g. a deploy action just ran against this node) is a deliberate
  // signal that the state may have changed -- it must not be silently dropped by a backoff window
  // from an earlier, unrelated failure.
  const failing = failures.get(dockerNodeId)
  if (failing) {
    failures.set(dockerNodeId, { ...failing, nextAttemptAt: 0 })
  }
  pollOne(dockerNodeId).catch((err) => {
    console.error(`[docker-ps-poller] refresh ${dockerNodeId} failed`, err)
  })
}

interface SchedulerHandle {
  timer: NodeJS.Timeout
}

const globalForScheduler = globalThis as unknown as {
  __DOCKER_PS_POLLER__?: SchedulerHandle
  __dockerPsInvalidated?: (id: string) => void
}

export function startDockerPsPoller(): void {
  if (globalForScheduler.__DOCKER_PS_POLLER__) {
    return
  }
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[docker-ps-poller] tick failed', err)
    })
  }, TICK_MS)
  globalForScheduler.__DOCKER_PS_POLLER__ = { timer }
  globalForScheduler.__dockerPsInvalidated = refreshDockerNode
  console.log(`[docker-ps-poller] started (tick every ${TICK_MS}ms)`)
  tick().catch((err) => {
    console.error('[docker-ps-poller] initial tick failed', err)
  })
}
