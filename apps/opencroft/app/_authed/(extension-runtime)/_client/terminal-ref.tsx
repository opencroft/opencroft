'use client'

import { type GraphRefState, useGraphRef } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { RefLabel, refDisplay } from '@/app/_authed/(extension-runtime)/_client/node-ref'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  className?: string
}

// What tells this terminal apart from its node's other outputs: a dynamic
// handle's expanded remainder (a container, a worktree). A node's one plain
// terminal output needs nothing -- its label would only repeat "Terminal" --
// so a static label is shown only when the node has several to choose from.
function handleDetail(ref: GraphRefState, handleId: string): string {
  if (ref.status !== 'known') {
    return ''
  }
  if (ref.info.kind !== 'node') {
    return handleId === 'terminal' ? '' : handleId
  }
  const handles = extensionRegistry.resolveNode(ref.info.typeId)?.handles ?? []
  const handle = findExtensionHandle(handles, handleId, 'source')
  if (!handle) {
    return handleId
  }
  if (handle.dynamic) {
    return handleId.slice(handle.id.length)
  }
  const plainTerminals = handles.filter(
    (h) => h.role === 'source' && h.contextType === handle.contextType && !h.dynamic,
  )
  return plainTerminals.length > 1 ? (handle.label ?? handleId) : ''
}

/**
 * A terminal target shown as its node's icon and name plus which terminal of
 * that node it is, instead of the raw "node-id/handle-id".
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalRef({ target, className }: TerminalRefProps) {
  const slash = target.indexOf('/')
  const nodeId = slash > 0 ? target.slice(0, slash) : target
  const handleId = slash > 0 ? target.slice(slash + 1) : ''
  const ref = useGraphRef(nodeId)
  const display = refDisplay(ref, nodeId)
  return (
    <RefLabel
      display={{ ...display, hint: `${display.hint}/${handleId}` }}
      detail={handleDetail(ref, handleId) || undefined}
      className={className}
    />
  )
}
