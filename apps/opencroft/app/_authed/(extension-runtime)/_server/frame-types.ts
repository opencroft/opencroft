// Which stored node types are frames, read from the installed extensions'
// manifests (see `isFrameType`). The server's counterpart to the canvas asking
// its registry.

import { isFrameType } from '@/app/_authed/(extension-runtime)/_frames'

/** Whether a stored node is a frame, by the node types given. */
export function frameTestOf(
  nodeTypes: Iterable<{ type: string; category?: string }>,
): (node: { type?: unknown }) => boolean {
  const frames = new Set<string>()
  for (const nodeType of nodeTypes) {
    if (isFrameType(nodeType)) {
      frames.add(nodeType.type)
    }
  }
  return (node) => typeof node.type === 'string' && frames.has(node.type)
}

/** Whether a stored node is a frame, by the types installed now. */
export async function frameTest(): Promise<(node: { type?: unknown }) => boolean> {
  // Imported on use: the loader builds extension hosts, which read graphs.
  const { loadAllManifests } = await import('@/app/_authed/(extension-runtime)/_server/loader')
  return frameTestOf((await loadAllManifests()).flatMap((manifest) => manifest.nodes ?? []))
}
