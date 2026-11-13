// The actions a graph run has entered and not yet left, so that a run never
// re-enters one of them: a Call Action whose call leads back to itself, or to
// an action that is still waiting on it, would otherwise recurse until the
// process gives out. One stack per chain, kept by AsyncLocalStorage: what a
// run awaits inside a frame sees the frame, and two runs started side by side
// (two edges out of one handle, two Events) each see only their own.

import { AsyncLocalStorage } from 'node:async_hooks'

/** One action entered: of a node, or of an App instance (`owner`), and the name a refusal shows it by. */
export interface CallFrame {
  owner: string
  action: string
  label: string
}

/** How many actions one chain may have entered at once. */
export const MAX_CALL_DEPTH = 32

const storage = new AsyncLocalStorage<readonly CallFrame[]>()

function chainText(frames: readonly CallFrame[]): string {
  return frames.map((frame) => `${frame.label} › ${frame.action}`).join(' → ')
}

/** The actions entered and not yet left around the caller, outermost first. */
export function currentCallStack(): readonly CallFrame[] {
  return storage.getStore() ?? []
}

/**
 * Runs `run` with `frame` entered. Refused, before anything runs, when the
 * same action of the same owner is already entered in this chain, naming the
 * loop, and when the chain has entered `MAX_CALL_DEPTH` actions already.
 */
export function inCallFrame<T>(frame: CallFrame, run: () => Promise<T>): Promise<T> {
  const stack = currentCallStack()
  const at = stack.findIndex((entered) => entered.owner === frame.owner && entered.action === frame.action)
  if (at !== -1) {
    return Promise.reject(
      new Error(
        `Refused a loop: ${frame.label} › ${frame.action} is already running in this chain (${chainText([...stack.slice(at), frame])}).`,
      ),
    )
  }
  if (stack.length >= MAX_CALL_DEPTH) {
    return Promise.reject(
      new Error(
        `Refused: this chain has entered ${MAX_CALL_DEPTH} actions without finishing one, the most a run may (${chainText(stack.slice(0, 3))} → …).`,
      ),
    )
  }
  return storage.run([...stack, frame], run)
}
