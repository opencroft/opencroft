'use client'

import { TerminalPath } from 'ui/nodes/terminal-list'

import { describeGraphRef, splitTarget, useGraphRef } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { RefLabel, refDisplay } from '@/app/_authed/(extension-runtime)/_client/node-ref'
import { placeOf } from '@/app/_authed/(extension-runtime)/_client/terminal-sources'

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  /**
   * Show where the terminal is, Space › App › Terminal, shortened by the width
   * its container gives it (see Terminal Path). For a terminal shown away from
   * its context.
   */
  path?: boolean
  className?: string
}

/**
 * A terminal target shown as its owner's icon and the terminal's one name --
 * the name the TerminalSelector lists it by -- instead of the raw
 * "node-id/handle-id"; with `path`, also where it is.
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalRef({ target, path, className }: TerminalRefProps) {
  const { nodeId, handleId } = splitTarget(target)
  // The whole target, so the answer carries the terminal's name.
  const ref = useGraphRef(target)
  const display = refDisplay(ref, nodeId)
  if (ref.status !== 'known') {
    return <RefLabel display={display} className={className} />
  }
  const described = describeGraphRef(ref.info)
  if (path) {
    const { space, app } = placeOf(described, nodeId)
    return (
      <TerminalPath
        name={described.title}
        space={space?.name}
        app={app?.name}
        icon={display.icon}
        accent={display.accent}
        className={className}
      />
    )
  }
  return (
    <RefLabel
      display={{ ...display, name: described.title, hint: `${display.hint}/${handleId}` }}
      className={className}
    />
  )
}
