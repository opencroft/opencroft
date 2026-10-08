import { endSharedSession } from '@opencroft/terminal/server'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/**
 * A shared terminal shell is opened under the id of the node it belongs to and outlives every
 * viewer, so nothing on the client can end it. It ends here, when that node leaves its graph:
 * deleted, closed from its own window, or gone with its graph or space.
 */
export function endSharedShellsWithTheirNodes(): void {
  getSpacesRegistry().onNodesRemoved((nodeIds) => {
    for (const nodeId of nodeIds) {
      endSharedSession(nodeId)
    }
  })
}
