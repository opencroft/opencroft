// What a node is called: the name the canvas shows on it, and the one lists of
// the graph's nodes (the Outline, the command bar) and an extension's `{name}`
// in a file name give it, so they all read alike.

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The name of a node with `data`, of the type named `typeName`: a frame's
 * Label (a Section's or a Network's), else its name or title (an Agent's, an
 * Application's), else its type's name, else `id`.
 */
export function nodeName(data: unknown, typeName: string | undefined, id: string): string {
  const fields = (data ?? {}) as Record<string, unknown>
  return text(fields.label) || text(fields.name) || text(fields.title) || typeName || id
}
