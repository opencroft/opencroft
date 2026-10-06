'use client'

import { describeGraphRef, splitTarget, useGraphRef } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { RefLabel, refDisplay } from '@/app/_authed/(extension-runtime)/_client/node-ref'

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  className?: string
}

/**
 * A terminal target shown as its node's icon and name plus which terminal of
 * that node it is, instead of the raw "node-id/handle-id".
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalRef({ target, className }: TerminalRefProps) {
  const { nodeId, handleId } = splitTarget(target)
  // The whole target, so an App's answer carries its name for the handle.
  const ref = useGraphRef(target)
  const display = refDisplay(ref, nodeId)
  const detail = ref.status === 'known' ? describeGraphRef(ref.info, handleId).detail : undefined
  return (
    <RefLabel display={{ ...display, hint: `${display.hint}/${handleId}` }} detail={detail} className={className} />
  )
}
