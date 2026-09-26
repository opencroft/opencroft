/** The `<node-id>/<handle-id>` grammar every tool that names an edge end or a terminal target takes. */

export interface ParsedEndpoint {
  nodeId: string
  handle?: string
}

/** Split at the FIRST "/": the node id never contains one, a handle id may. */
export function parseEndpoint(raw: string): ParsedEndpoint {
  const i = raw.indexOf('/')
  if (i === -1) {
    return { nodeId: raw }
  }
  return { nodeId: raw.slice(0, i), handle: raw.slice(i + 1) }
}
