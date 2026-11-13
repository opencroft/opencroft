/**
 * `@opencroft/client/values` — plain values (text, numbers, true/false) on the
 * canvas: the three primitive handle types (`builtin.core.string`, `.number`,
 * `.boolean`) and which of them connect, `inputValue`, the reader of a value
 * input (wired, typed into the node, or its declared default), and the
 * expression, template and pattern engines. The same source as
 * `@opencroft/server/values`, so a value reads the same on the canvas and in a
 * node action.
 */
export * from '@opencroft/core/values'
