/**
 * `@opencroft/server/actions` — the actions an extension's server module
 * exports, and what each is handed when it runs:
 *
 *     export const actions = { … } satisfies ExtensionActions
 *     export const nodeActions = { … } satisfies NodeActions
 *
 * `actions` are the extension's own, run from its client with `invoke`
 * (`@opencroft/client/actions`). `nodeActions` belong to its node types and run
 * on one node: from the node's UI with `dispatch`, from an agent with the MCP
 * `call` tool, or from the graph (an execution context, a stream). Both are
 * keyed by name; each node action's label, description and input schema are
 * declared beside the node in `extension.json` (`nodes[].actions`), keyed by
 * the same id.
 */

import type { EnumCasesOf } from '@opencroft/core/values'

/** One of the extension's own actions: called with the arguments `invoke` passed, its result returned to the caller. */
// Each action declares its own parameters, and a parameter list is checked
// contravariantly, so no one parameter type admits all of them.
// biome-ignore lint/suspicious/noExplicitAny: a map of actions each typed on its own arguments
export type ExtensionAction = (...args: any[]) => unknown

/** The `actions` export: the extension's own actions by name. */
export type ExtensionActions = Record<string, ExtensionAction>

/**
 * Who may run an action from the browser. `signed-in` (the default for an
 * action not listed) is any signed-in person; `admin` refuses everyone else
 * with a 403 before the handler runs. Agents and the graph reach node actions
 * without this check: it guards the browser's entry point only.
 */
export type ActionAccess = 'signed-in' | 'admin'

/** The `actionAccess` export: the policy of each of the extension's own `actions` that is not `signed-in`. */
export type ActionAccessMap = Record<string, ActionAccess>

/** The `nodeActionAccess` export: like `actionAccess`, keyed by bare node type and then action id. */
export type NodeActionAccessMap = Record<string, Record<string, ActionAccess>>

/** A live stream of values, the same shape as the client's `Stream` (`@opencroft/client/streams`). */
export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

/** The value wired into one of the node's target handles, with where it came from. */
export interface ResolvedInput<T = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  /** The qualified handle type of the source handle. */
  handleType: string
  /** @deprecated Read `handleType`, which holds the same value. */
  contextType: string
  value: T
}

/** A node wired into one of this node's target handles. */
export interface ConnectedSource {
  nodeId: string
  handleId: string
  /** The node's stored, qualified type. */
  type?: string
  data: Record<string, unknown>
}

/** A node on the same graph, as `containingNodes` returns it. */
export interface NodeActionContextNode {
  id: string
  /** The node's stored, qualified type. */
  type?: string
  /** Where its top-left corner is drawn on the canvas. */
  position: { x: number; y: number }
  data: Record<string, unknown>
}

/**
 * What a node action is handed: the node, the parameters of the call, and the
 * node's place in the graph. `D` is the node's data and `P` the call's
 * parameters, both unchecked: the host passes what the graph stores and what
 * the caller sent.
 */
export interface NodeActionContext<D = Record<string, unknown>, P = Record<string, unknown>> {
  nodeId: string
  /** The node's BARE type — the name the extension running the action declared it under. */
  type: string
  /** @deprecated Read `type`, which holds the same bare value. */
  typeId: string
  data: D
  /**
   * The call's parameters, as the caller passed them. For the action named
   * `handle` of a node fed by an execution context, the request event
   * (`{ method, path, params, query, headers, body }`); for a handle's
   * `streamAction`, `{ text }`.
   */
  params: P
  /**
   * The value wired into `handleId`, or undefined when nothing is. For a
   * declared input of a primitive type (`@opencroft/server/values`), what
   * `inputValue` reads: the wired value converted to the input's type (a
   * number into a text input as its text, a number into an `integer` input
   * rounded), else the value typed on the node's card (`data.inputs`), else
   * the declared `default`; undefined while a wired source exposes nothing.
   */
  input<T = unknown>(handleId: string): T | undefined
  /**
   * The value wired into `handleId` with where it came from, or undefined when
   * nothing is: an edge's value as its source exposes it, never a typed one.
   */
  inputSource<T = unknown>(handleId: string): ResolvedInput<T> | undefined
  /**
   * The nodes wired into `handleId`, each with the qualified `type` the graph
   * stores: through a subgraph's port, the real node on the other side of it.
   */
  connectedSources(handleId: string): ConnectedSource[]
  /**
   * The frames this node is inside, innermost first: its parent, its
   * parent's parent, and so on. A node is inside a frame it was placed in
   * (dropped, created or moved there), and stays until it is placed outside
   * it. Each comes with its stored, qualified `type` and the absolute
   * `position` it is drawn at. `type` narrows them: bare for one of the
   * calling extension's own types, qualified for any extension's.
   */
  containingNodes(type?: string): NodeActionContextNode[]
  /**
   * The stream of the node's source handle `handleId`. On a
   * `builtin.core.text-stream` handle, broadcasting `{ text, final: true }`
   * delivers the accumulated text to what is wired downstream (Log and
   * send-message nodes, and any target handle declaring a `streamAction`).
   */
  output<T = unknown>(handleId: string): Stream<T>
  /** Persist a patch to this node's stored data (e.g. assign a key). */
  updateData(patch: Partial<D>): void
  /**
   * The agent that invoked this action, when the surface that dispatched it
   * had one and could name it. Absent for a graph-driven run, where the
   * question is not "who asked" but "what fed this" -- that is `inputSource`,
   * and the two are never the same answer.
   *
   * A NAME, not a handle: what the dispatching surface resolved, unmodified.
   * An action that needs a durable identifier turns it into one where the
   * identifier is minted, so nothing here has to know what that costs.
   */
  callerAgent?: string
  /**
   * Aborted when whoever is waiting on this run gives up on it: a background
   * task cancelled by its caller, or out of time. Absent when nothing can
   * cancel the run — a button press, a graph-driven dispatch.
   *
   * Advisory. An action that never looks at it runs to its end regardless,
   * which is why a cancel of one is reported as requested, not done; one
   * that can stop part-way (a long pull, a loop over hosts) checks it
   * between steps and gives up there.
   */
  signal?: AbortSignal
}

/**
 * One node action. Its result (or what its promise resolves to) is the
 * call's answer; for `handle` on an execution-context target, `{ status, body }`
 * is the HTTP answer.
 *
 * A failure is recorded on the node as its `action` error (see `NodeError`)
 * until the next action on it starts. An error thrown with a `problem` property
 * holding a `NodeError` is recorded and answered to an agent's `call` as that
 * problem; any other is recorded, and answered, with the action's name as its
 * title and the error's message as its detail. A failure the action already
 * reported on the node under its own source (`graph.setNodeErrors`) is not
 * recorded a second time as the `action` error; the agent's `call` is still
 * answered with it.
 */
// Each node type reads its own data and each action its own parameters; see
// `ExtensionAction` for why no one context type admits all of them.
// biome-ignore lint/suspicious/noExplicitAny: a map of handlers each typed on its own data and parameters
export type NodeActionHandler<D = any, P = any> = (ctx: NodeActionContext<D, P>) => unknown

/** The `nodeActions` export: by the node's bare type, then by action id. */
export type NodeActions = Record<string, Record<string, NodeActionHandler>>

/**
 * The `exposeOutput` export: the value a node's source handle carries, for
 * server-side readers of the graph (the context resolver, execution
 * contexts). The client's `NodeDefinition.exposeOutput` answers the same
 * question on the open canvas. Told the node's bare type and id.
 *
 * `nodeData` carries the node's own wired inputs as the resolver has them so
 * far: `__resolvedContexts`, each input handle's `{ sourceNodeId,
 * sourceHandleId, handleType, value }`, and `__unresolvedInputs`, the ids of
 * the input handles that are wired but whose source exposes nothing. A handle
 * in neither is not wired. An output that falls back to a default while an
 * input is absent should fall back only for an input that is not wired:
 * returning nothing for an unresolved one leaves everything under it
 * unresolved too, rather than acting on the default. Both are read again
 * whenever an input changes, so the answer may be asked for several times.
 *
 * `run` is the event this node dispatched in the current run (what an API
 * Route, an Event or an Agent Tool hands its `exec-out` targets), or undefined
 * outside one. A handle declared `runtime: true` answers from it, and answers
 * nothing while it is undefined. It is only ever read, never stored: the
 * resolution that sees it serves one dispatch of that run.
 *
 * `enumCasesOf` gives the cases of each enum the installed extensions declare
 * (`@opencroft/server/values`), for an output that reads an input of an enum
 * type through them: it is synchronous, so it cannot ask `graph.getHandleType`.
 *
 * Every reader asks the same question, so the answer does not depend on who
 * asks. When a wired node may use a terminal context but agents may not, the
 * context carries the reason in `agentRefusal` (`TerminalContext`) rather
 * than being withheld: thrown here, it would also be refused to the nodes a
 * person wired to the handle. Whatever resolves a terminal for an agent
 * refuses it with that reason (`agentRefusalOf`, `@opencroft/server/terminal`).
 */
export type ExposeOutput = (
  handleId: string,
  nodeData: Record<string, unknown>,
  type: string,
  nodeId: string,
  run?: unknown,
  enumCasesOf?: EnumCasesOf,
) => unknown
