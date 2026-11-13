/**
 * `@opencroft/server/values` — plain values (text, numbers, true/false) on the
 * graph: the three primitive handle types (`builtin.core.string`, `.number`,
 * `.boolean`) and which of them connect, `inputValue`, the reader of a value
 * input (wired, typed into the node, or its declared default), and the
 * expression, template and pattern engines. The same source as
 * `@opencroft/client/values`, so a value reads the same in a node action and
 * on the canvas. A node action's `ctx.input` already reads a value input
 * through `inputValue`.
 */
export * from '@opencroft/core/values'
