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
