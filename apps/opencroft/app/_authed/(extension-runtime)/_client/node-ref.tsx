'use client'

import { cn } from 'cn'
import { AppWindow, Box, type LucideIcon } from 'lucide-react'

import { describeGraphRef, type GraphRefState, useGraphRef } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

export interface NodeRefProps {
  /** A graph node id, or an App instance's id / `<space>.<app-slug>` address. */
  nodeId: string
  /** Text after the name, e.g. which of the node's handles is meant. */
  detail?: string
  className?: string
}

interface RefDisplay {
  icon: LucideIcon
  accent?: string
  name: string
  /** Hover text: type, space and the raw id, for when the name is not enough. */
  hint: string
  known: boolean
}

export function refDisplay(ref: GraphRefState, id: string): RefDisplay {
  if (ref.status !== 'known') {
    return {
      icon: Box,
      name: ref.status === 'loading' ? '…' : 'Unknown node',
      hint: id,
      known: false,
    }
  }
  const described = describeGraphRef(ref.info)
  return {
    icon: described.kind === 'app' ? AppWindow : resolveIcon(described.icon),
    accent: described.accent,
    name: described.name,
    hint: `${described.typeName} · ${described.spaceSlug} · ${id}`,
    known: true,
  }
}

export function RefLabel({ display, detail, className }: { display: RefDisplay; detail?: string; className?: string }) {
  const Icon = display.icon
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5', !display.known && 'text-muted-foreground', className)}
      title={detail ? `${display.hint} · ${detail}` : display.hint}
    >
      <Icon className='size-3.5 shrink-0' style={display.accent ? { color: display.accent } : undefined} />
      <span className='truncate'>
        {display.name}
        {detail ? <span className='text-muted-foreground'> · {detail}</span> : null}
      </span>
    </span>
  )
}

/**
 * A node (or App instance) shown by what it is -- its icon and name -- rather
 * than by its id. Resolves across every space; the raw id stays on hover.
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function NodeRef({ nodeId, detail, className }: NodeRefProps) {
  const ref = useGraphRef(nodeId)
  return <RefLabel display={refDisplay(ref, nodeId)} detail={detail} className={className} />
}
