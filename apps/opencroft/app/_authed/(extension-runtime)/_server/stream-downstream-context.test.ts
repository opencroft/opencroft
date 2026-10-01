// A completed text stream wired into a `text-generation` node dispatches that
// node's `run` action — its `text-in` handle declares `streamAction: "run"`.
// The broadcast that triggers this can happen with NO TanStack request context:
// a background scheduler tick drives exec-dispatch, which broadcasts on a script
// node's `stdout-out`, and stream completion then dispatches downstream.
//
// Routed through the `dispatchNodeAction` server function, that dispatch was
// silently dropped: a createServerFn invoked in-process outside a request throws
// before its handler runs (no Start context in AsyncLocalStorage), and the throw
// is swallowed by stream.ts's per-dispatch try/catch, so the downstream node
// never runs. The dispatch must go through the request-context-free impl
// instead, like every other internal caller (exec-dispatch uses the impl for
// exactly this reason).
//
// Runs deliberately outside any request/middleware context, mirroring
// exec-dispatch-no-context.test.ts. Uses the real builtin/core bundle so
// text-generation's manifest handle (and its `run` action) are the real ones.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { broadcast, getStream } from './stream'

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (cond()) {
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

test('a completed stream dispatches a downstream text-generation.run with no request context', async () => {
  const slug = `stream-downstream-context-${crypto.randomUUID()}`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, {
    nodes: [
      { id: 'src-1', type: 'builtin.core.prompt', position: { x: 0, y: 0 }, data: {} },
      { id: 'tg-1', type: 'builtin.core.text-generation', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'edge-1', source: 'src-1', target: 'tg-1', sourceHandle: 'text-out', targetHandle: 'text-in' },
    ],
  })

  const errors: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '))
  }
  try {
    // No request context here on purpose — the background-tick situation.
    broadcast(getStream<{ text: string; final: boolean }>(slug, 'src-1', 'text-out'), {
      text: 'hello downstream',
      final: true,
    })
    await waitFor(
      () =>
        errors.some((e) => /\[stream→builtin\.core\.text-generation\.run\] dispatch failed/.test(e)) ||
        errors.some((e) => /\[node-action\] builtin\.core\.text-generation\.run/.test(e)),
      'the downstream text-generation.run dispatch to resolve',
    )
  } finally {
    console.error = orig
  }

  // The dispatch must REACH the node-action impl, which then fails on this
  // fixture's own missing assistant — a deterministic domain error, not a
  // context/authorization refusal. Routed through the server function from a
  // request-less caller, the impl is never entered and this line is absent.
  assert.ok(
    errors.some((e) => /\[node-action\] builtin\.core\.text-generation\.run/.test(e)),
    `text-generation.run was never reached — the request-less dispatch was blocked before the action. Captured: ${JSON.stringify(errors)}`,
  )
  const streamFailure =
    errors.find((e) => /\[stream→builtin\.core\.text-generation\.run\] dispatch failed/.test(e)) ?? ''
  assert.match(
    streamFailure,
    /No assistant selected/,
    `expected the downstream dispatch to fail on the fixture's missing assistant, not an auth refusal. Got: ${streamFailure}`,
  )
})
