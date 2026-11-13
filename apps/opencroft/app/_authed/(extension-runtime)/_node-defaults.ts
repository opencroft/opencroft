// A new node's data: one rule for the palette, the extension preview, the
// graph's createNodes and a server extension's createNode, so a node an agent
// creates holds what the same node dropped from the palette holds.
//
// Safe for both server and client — no runtime imports.

/**
 * The data a node of a type with `defaults` starts with: every default, with
 * each top-level field the creator gives in its place. Plain arrays and
 * objects in the defaults are copied deep, so nodes created from one
 * declaration share none of them; every other value (a function, a class
 * instance, a frozen object such as a React element) is kept as given.
 */
export function newNodeData(
  defaults: Record<string, unknown> | undefined,
  given?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...copyPlain(defaults), ...given }
}

// What a node could change in place: an array, or an object made by a literal
// or `Object.create(null)`, that is not frozen. A frozen value can't change, and
// React's development elements are frozen and carry non-enumerable fields a
// copy would lose. A Proxy can't be told from its target, so one over a plain
// object is read through its traps.
function isPlainContainer(value: object): boolean {
  if (Object.isFrozen(value)) {
    return false
  }
  if (Array.isArray(value)) {
    return true
  }
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && Object.getOwnPropertySymbols(value).length === 0
}

function copyPlain<T>(value: T): T {
  if (typeof value !== 'object' || value === null || !isPlainContainer(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(copyPlain) as T
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyPlain(item)])) as T
}
