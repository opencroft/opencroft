/**
 * The reason a context's source gave for refusing it to agents (`TerminalContext.agentRefusal`),
 * or null when it gave none. Every surface an agent reaches a terminal through asks this of the
 * context it resolved, and refuses with the reason when there is one.
 *
 * Takes any object, not only a `TerminalContext`: a context arrives from node data and extension
 * code as a plain record, and the field is checked here rather than trusted to be a string.
 */
export function agentRefusalOf(ctx: Readonly<Record<string, unknown>>): string | null {
  const refusal = ctx.agentRefusal
  return typeof refusal === 'string' && refusal.trim() !== '' ? refusal : null
}
