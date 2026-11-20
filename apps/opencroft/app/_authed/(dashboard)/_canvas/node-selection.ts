import { nodeName } from '@opencroft/core/values'

import type { Selection, SelectionItem } from '@/app/_authed/(agent)/_shared/selection-envelope'
import { INPUTS_BOUNDARY_TYPE, OUTPUTS_BOUNDARY_TYPE } from '@/app/_authed/(dashboard)/_canvas/subgraph-level'

/** The parts of a canvas node this is allowed to look at. */
export interface SelectableNode {
  id: string
  type?: string
  data?: unknown
  selected?: boolean
}

/**
 * Node types the canvas draws and the graph never stores: an agent's comment
 * bubble (from graph events) and a subgraph's Inputs and Outputs. A reference
 * to one would come back from `getNodes` as missing.
 */
const BROWSER_ONLY_TYPES: ReadonlySet<string> = new Set(['comment', INPUTS_BOUNDARY_TYPE, OUTPUTS_BOUNDARY_TYPE])

/**
 * What the selected canvas nodes say to an agent: one `node` item per selected
 * node the graph stores, on the graph at `graph`, quoted at `place`. Null with
 * nothing of the graph's selected.
 *
 * ID, NAME AND TYPE ONLY. This is a decision about disclosure, not a summary
 * that happens to be short: a node's `data` is whatever its extension keeps in
 * it -- credentials, prompts, endpoints -- and the item travels with a message
 * sent to an agent. The agent reads the rest through `getNodes`, which redacts
 * credentials. Widening the item is a decision someone has to take
 * deliberately, which is why the reading of `data` here is narrowed to the
 * naming fields rather than the object being passed along and trimmed at the
 * far end.
 *
 * THE NAME IS THE ONE THE CANVAS SHOWS. It is `nodeName`'s, the rule the
 * Outline and the command bar name a node by: the node's label, name or title,
 * else its type's name (`typeName`, from the extension registry), else its id.
 * The registry does not notify React, so the caller passes `typeName` from
 * code that keys on the registry's version.
 */
export function nodeSelection(
  nodes: readonly SelectableNode[],
  graph: string,
  place?: string,
  typeName: (type: string) => string | undefined = () => undefined,
): Selection | null {
  const items: SelectionItem[] = nodes
    .filter((node) => node.selected && !BROWSER_ONLY_TYPES.has(node.type ?? ''))
    .map((node) => ({
      kind: 'node',
      graph,
      id: node.id,
      name: nodeName(node.data, node.type ? typeName(node.type) : undefined, node.id),
      type: node.type ?? 'unknown',
    }))
  return items.length > 0 ? { items, ...(place ? { place } : {}) } : null
}
