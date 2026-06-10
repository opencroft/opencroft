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
