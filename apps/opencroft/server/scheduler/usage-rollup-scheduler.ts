// Host wiring for the daily usage rollup. @opencroft/usage-rollup stays
// host-agnostic (it takes places + an execIn function as plain arguments);
// this file is the one place that knows how to resolve those from the space
// graph -- each agent's terminal, the place its harness runs and keeps its
// transcripts -- and how to deliver the result into a group-chat thread,
// same split as registerThreadDeliveryResolver's own header explains for
// send-message node delivery.

import { terminalExecResult } from '@opencroft/terminal/server'
import { getUsageRollupConfig, runUsageRollupTick, setUsageRollupConfig } from '@opencroft/usage-rollup'

import { isAgentNode } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { resolveTerminalTarget } from '@/app/_authed/(extension-runtime)/_server/host'
import { sendMessageInThreadAsAgent } from '@/app/_authed/(group-chats)/_server/model'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

const TICK_MS = 15 * 60_000
const EXEC_TIMEOUT_MS = 120_000

interface GraphNode {
  type?: string
  data?: Record<string, unknown>
}

// The distinct terminals agents run through, as their targets.
function collectAgentTerminals(): string[] {
  const registry = getSpacesRegistry()
  const targets = new Set<string>()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const spaceNodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes)
    for (const node of spaceNodes as unknown as GraphNode[]) {
      const terminal = node.data?.terminal
      if (isAgentNode(node) && typeof terminal === 'string' && terminal.trim()) {
        targets.add(terminal.trim())
      }
    }
  }
  return Array.from(targets)
}

async function execInTerminal(target: string, command: string): Promise<string> {
  const result = await terminalExecResult(await resolveTerminalTarget(target), command, {
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
  const places = collectAgentTerminals()
  if (places.length === 0) {
    return
  }
  const result = await runUsageRollupTick({ places, execIn: execInTerminal })
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
