import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import type { DockerContainerSnapshot } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'

const TICK_MS = 10_000

interface GraphNode {
  id?: string
  type?: string
}

interface PollerState {
  lastSnapshot: Map<string, DockerContainerSnapshot[]>
  inFlight: Set<string>
}

const g = globalThis as Record<string, unknown>
if (!g.__DOCKER_PS_STATE__) {
  g.__DOCKER_PS_STATE__ = {
    lastSnapshot: new Map<string, DockerContainerSnapshot[]>(),
    inFlight: new Set<string>(),
  } satisfies PollerState
}
const state = g.__DOCKER_PS_STATE__ as PollerState
const lastSnapshot = state.lastSnapshot
const inFlight = state.inFlight

function collectDockerNodeIds(): string[] {
  const r = getSpacesRegistry()
  const ids: string[] = []
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    for (const node of space.graph.nodes as unknown as GraphNode[]) {
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

async function callDockerPs(dockerNodeId: string): Promise<DockerContainerSnapshot[]> {
  const mod = await getExtensionModule('local/docker')
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
    const prev = lastSnapshot.get(dockerNodeId)
    if (prev && containersEqual(prev, fresh)) {
      return
    }
    lastSnapshot.set(dockerNodeId, fresh)
    toastStore.broadcast({ type: 'docker_ps_updated', dockerNodeId, containers: fresh })
  } catch (err) {
    console.error(`[docker-ps-poller] ${dockerNodeId} failed:`, err)
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
  await Promise.all(ids.map(pollOne))
}

export function getAllDockerSnapshots(): { dockerNodeId: string; containers: DockerContainerSnapshot[] }[] {
  return [...lastSnapshot.entries()].map(([dockerNodeId, containers]) => ({ dockerNodeId, containers }))
}

function refreshDockerNode(dockerNodeId: string): void {
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
