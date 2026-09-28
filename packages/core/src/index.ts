/**
 * Shared, isomorphic contracts used by both the client and server surfaces of
 * an OpenCroft extension. These describe the types, handles, and nodes an
 * extension contributes; the lifecycle hooks that register them live in
 * `@opencroft/server`.
 */

/** A connection type. Node handles reference a type by its `id`. */
export interface Type {
  id: string
  label: string
  color: string
  description?: string
}

/** A node handle, typed by a registered {@link Type} referenced via `type`. */
export interface Handle {
  id: string
  type: string
  role: 'source' | 'target'
  label?: string
}

/** An input parameter an App asks the user to fill in when adding it to a space. */
export interface AppParameter {
  id: string
  label: string
  description?: string
  placeholder?: string
  required?: boolean
}

/**
 * How a caller waits for an action or a tool.
 *
 * - `sync` — the call returns the result, and the caller waits for it.
 * - `awaitable` — the caller chooses per call. The input schema gains a
 *   `background` flag; a backgrounded call returns at once while the work
 *   carries on, and the caller is told when it ends.
 * - `async` — always detached: the call returns at once and the caller is told
 *   when the work ends. Its schema is the same as a `sync` one's, so it asks
 *   nothing new of a caller; only its description says there is a wait.
 *
 * Absent means `sync`, so everything declared before this existed behaves as
 * it did.
 */
export type ExecutionMode = 'sync' | 'awaitable' | 'async'

/**
 * An action one instance of an App exposes to agents (via the host's
 * `list_apps`/`app_call` MCP tools). Declared in the manifest so the host can
 * list it without loading the extension; the handler lives in the server
 * module's `apps[slug].actions[id]`.
 */
export interface AppActionMeta {
  id: string
  label?: string
  description?: string
  /** JSON schema for the action's params, surfaced to agents by `list_apps`. */
  inputSchema?: Record<string, unknown>
  /** How callers wait for it. Absent means `sync` — see {@link ExecutionMode}. */
  execution?: ExecutionMode
}

/**
 * A context SOURCE one instance of an App exposes, addressable as
 * `<instanceId>/<handleId>` everywhere a node's `<nodeId>/<handleId>` target
 * is accepted. A `dynamic` entry's id is a PREFIX; the live ids are asked of
 * the server module's `apps[slug].listHandles`, and each handle's value of
 * `apps[slug].getHandleContext`.
 */
export interface AppHandle {
  id: string
  contextType: string
  label?: string
  dynamic?: boolean
}

/**
 * An App an extension contributes via `provides.apps` in its manifest. Users
 * add Apps to a space; the values they enter for `parameters` are stored per
 * space. The React component rendering the App lives in the client bundle —
 * see `AppDefinition` in `@opencroft/client`.
 */
export interface AppEntry {
  slug: string
  title: string
  description?: string
  /** Lucide icon name, shown in App lists. */
  icon?: string
  parameters?: AppParameter[]
  actions?: AppActionMeta[]
  /** Context sources instances of this App expose (e.g. a terminal per worktree). */
  handles?: AppHandle[]
  /**
   * The App's pages that fill the whole window, with none of the host around
   * them: no title bar, no sidebars. Each entry is an App path pattern, the
   * form `useAppLocation().path` takes: `*` stands for exactly one segment, and
   * a final `**` for any number of them, none included — `/print/*` is every
   * page one segment under `/print`, `/preview/**` is `/preview` and
   * everything under it. Every other page keeps the host's chrome. A
   * full-page route keeps its App address and the same sign-in as any other
   * page.
   *
   * Read from the manifest, before the App's client bundle loads, so the page
   * is drawn without chrome from its first paint; a value given only in the
   * client's `AppDefinition` has no effect.
   */
  fullPageRoutes?: string[]
}

/** A node contributed by an extension. */
export interface Node {
  type: string
  name: string
  category?: string
  description?: string
  icon?: string
  accent?: string
  handles?: Handle[]
}
