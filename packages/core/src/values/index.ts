/**
 * `@opencroft/core/values` — plain values (text, numbers, true/false) and
 * objects on a graph: the value handle types and which of them connect, the
 * reader of a value input, the path a Get reads in an object, what a node's
 * data says about its wired inputs, and the expression, template and pattern
 * engines.
 * Host-free: the host serves this same source to extensions as
 * `@opencroft/client/values` and `@opencroft/server/values`.
 */
export * from './expression'
export * from './file-name'
export * from './node-name'
export * from './path'
export * from './pattern'
export * from './resolved-inputs'
export * from './template'
export * from './types'
