// The run scope: the events a run has dispatched so far, by the node that
// dispatched each. An execution chain (an API Route's request, an Event's
// fire, an Agent Tool's call, and every Switch or Call Action it passes
// through) runs inside it, so each dispatch on the way resolves its target's
// inputs with the producers' run-time outputs answering from their events.
//
// It travels in an AsyncLocalStorage, not as an argument: a handler that
// routes execution calls `execContext.dispatch` from inside its own `handle`,
// and that call sees the scope it was started in with no code of its own.
// Extensions run in the server's own process, so this holds for theirs too.
//
// What inherits a scope is everything started inside it, work a handler
// leaves running after it answers included. Concurrent runs each have their
// own. Nothing in a scope is written anywhere: the graph's stored contexts
// are resolved outside every run (see `findNodeWithGraph`, the one reader).
//
// Activating an extension is not part of any run, even when a run's dispatch
// is what first asks for the module (`getExtensionModule` runs it in
// `outsideRun`). Timers, sockets and subscriptions that evaluating the bundle
// or its `load()` registers live as long as the module, and would otherwise
// keep that one request's events and hand them to every dispatch they start.

import { AsyncLocalStorage } from 'node:async_hooks'

type RunScope = ReadonlyMap<string, unknown>

const storage = new AsyncLocalStorage<RunScope>()

/**
 * Runs `fn` inside the current run scope with `sourceNodeId`'s event set to
 * `event`: a run started here when there is none, else the same run, the
 * source's earlier event (a Switch dispatching twice) replaced.
 */
export function withRunEvent<T>(sourceNodeId: string, event: unknown, fn: () => T): T {
  const scope = new Map(storage.getStore() ?? [])
  scope.set(sourceNodeId, event)
  return storage.run(scope, fn)
}

/**
 * The events of the run in scope, by the node that dispatched each, or
 * undefined outside every run.
 */
export function currentRunEvents(): RunScope | undefined {
  return storage.getStore()
}

/** Runs `fn` outside every run, whatever scope it is called from. */
export function outsideRun<T>(fn: () => T): T {
  return storage.exit(fn)
}
