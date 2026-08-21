// Host wiring for the daily usage rollup. @opencroft/usage-rollup stays
// host-agnostic (it takes containerNames + an execInContainer function
// as plain arguments); this file is the one place that knows how to resolve
// those from the space graph and how to deliver the result into a group-chat
// thread, same split as registerThreadDeliveryResolver's own header explains
// for send-message node delivery.

import { terminalExecResult } from '@opencroft/terminal/server'
import { getUsageRollupConfig, runUsageRollupTick, setUsageRollupConfig } from '@opencroft/usage-rollup'

import { agentNodeContainerName, isAgentNode } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { sendMessageInThreadAsAgent } from '@/app/_authed/(group-chats)/_server/model'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

const TICK_MS = 15 * 60_000
const EXEC_TIMEOUT_MS = 120_000

interface GraphNode {
  type?: string
  data?: Record<string, unknown>
}

function collectAgentContainerNames(): string[] {
  const registry = getSpacesRegistry()
  const names = new Set<string>()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    for (const node of space.graph.nodes as unknown as GraphNode[]) {
      if (!isAgentNode(node)) {
        continue
      }
      const containerName = agentNodeContainerName(node)
      if (containerName) {
        names.add(containerName)
      }
    }
  }
  return Array.from(names)
}

async function execInContainer(containerName: string, command: string): Promise<string> {
  const result = await terminalExecResult({ type: 'docker-exec', containerId: containerName }, command, {
    timeoutMs: EXEC_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? ' (timed out)' : ''
    const suffix = result.stderr ? `: ${result.stderr}` : ''
    throw new Error(`rollup script exited with code ${result.exitCode}${detail}${suffix}`)
  }
  return result.stdout
}

async function tick(): Promise<void> {
  await getSpacesRegistry().ensureLoaded()
  const containerNames = collectAgentContainerNames()
  if (containerNames.length === 0) {
    return
  }
  const result = await runUsageRollupTick({ containerNames, execInContainer })
  if (!result.pendingDelivery) {
    return
  }
  const { day, message } = result.pendingDelivery
  try {
    const config = await getUsageRollupConfig()
    await sendMessageInThreadAsAgent(config.deliverAgentName, config.deliverThreadRef, message, 'wait')
    // Committed only after the send succeeds -- a failed send leaves
    // lastDeliveredDay unset so the next tick retries instead of skipping it.
    await setUsageRollupConfig({ lastDeliveredDay: day })
  } catch (err) {
    console.error(`[usage-rollup-scheduler] failed to deliver ${day} rollup`, err)
  }
}

interface SchedulerHandle {
  timer: NodeJS.Timeout
}

const globalForScheduler = globalThis as unknown as { __USAGE_ROLLUP_SCHEDULER__?: SchedulerHandle }

export function startUsageRollupScheduler(): void {
  if (globalForScheduler.__USAGE_ROLLUP_SCHEDULER__) {
    return
  }
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[usage-rollup-scheduler] tick failed', err)
    })
  }, TICK_MS)
  globalForScheduler.__USAGE_ROLLUP_SCHEDULER__ = { timer }
  console.log(`[usage-rollup-scheduler] started (tick every ${TICK_MS}ms)`)
}
