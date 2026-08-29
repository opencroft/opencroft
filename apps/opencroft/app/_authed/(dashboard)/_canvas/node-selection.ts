import type { UserSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

/** The parts of a canvas node this is allowed to look at. */
export interface SelectableNode {
  id: string
  type?: string
  data?: unknown
}

/**
 * What a selected canvas node says to an agent.
 *
 * ID, NAME AND TYPE ONLY. This is a decision about disclosure, not a summary
 * that happens to be short: a node's `data` is whatever its extension keeps in
 * it -- credentials, prompts, endpoints -- and this string is attached to a
 * message sent to an agent. Widening it later is a decision someone has to take
 * deliberately, which is why the reading of `data` here is narrowed to the two
 * naming fields rather than the object being passed along and trimmed at the
 * far end.
 *
 * The name is read from the node's own fields rather than resolved through the
 * extension registry. The registry does not notify React, so a component
 * reading it has to key on `extensionsVersion` or serve a stale answer; the
 * type id is in the content regardless, so consulting it would buy a nicer
 * label for a reactivity hazard.
 */
export function nodeSelection(node: SelectableNode): UserSelection {
  const named = node.data as { name?: unknown; title?: unknown } | undefined
  const name =
    (typeof named?.name === 'string' && named.name) || (typeof named?.title === 'string' && named.title) || node.id
  return {
    label: name,
    content: [`Selected node: ${name}`, `Type: ${node.type ?? 'unknown'}`, `Id: ${node.id}`].join('\n'),
  }
}
