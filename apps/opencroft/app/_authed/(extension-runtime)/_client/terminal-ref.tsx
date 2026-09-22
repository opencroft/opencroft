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

// What tells this terminal apart from its node's other outputs -- the same
// rule the TerminalSelector titles its choices by: a dynamic handle's
// expanded remainder (a container, a worktree), else the handle's label.
function handleDetail(ref: GraphRefState, handleId: string): string {
  if (ref.status !== 'known' || ref.info.kind !== 'node') {
    return handleId
  }
  const handles = extensionRegistry.resolveNode(ref.info.typeId)?.handles ?? []
  const handle = findExtensionHandle(handles, handleId, 'source')
  if (!handle) {
    return handleId
  }
  return handle.dynamic ? handleId.slice(handle.id.length) : (handle.label ?? '')
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
