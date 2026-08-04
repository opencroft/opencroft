'use client'

import { Skeleton } from 'ui/skeleton'

import { NodeCard } from '@/app/_authed/(dashboard)/_canvas/node-card'

interface UnresolvedNodeProps {
  /** The node type the graph asked for, which nothing has claimed. */
  type: string
  /** The node's own name. The graph carries it before its extension exists. */
  name?: string
  /** Whether extension loading has finished — successfully or not. */
  settled: boolean
}

/**
 * A node whose type no extension has claimed.
 *
 * Two states live here and they must not look alike. Still loading is transient
 * and needs nobody to do anything; genuinely missing is a fault someone has to
 * act on. A transient state wearing the fault's appearance is precisely how
 * people are taught to ignore the fault.
 *
 * They differ on three independent channels, so no single one carries the
 * distinction alone: colour (neutral against destructive), motion (pulsing
 * against still), and words (a name against a named missing type).
 *
 * Which state applies is decided by whether extension loading has FINISHED,
 * never by how long it has been going. Elapsed time would paint a healthy node
 * as broken on a slow connection, which is the failure this design exists to
 * avoid.
 */
export function UnresolvedNode({ type, name, settled }: UnresolvedNodeProps) {
  if (settled) {
    return (
      <div className='rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs'>
        Unknown extension: {type}
      </div>
    )
  }
  return (
    // PLACEHOLDER — the loading node's appearance belongs in the design kit and
    // is being drawn there. This is the plainest composition that makes no
    // design claim of its own: the ordinary node shell, the name the graph
    // already gave us, and one neutral bar standing in for whatever the
    // extension will render. Swap it for the kit component; do not grow it.
    <NodeCard className='max-w-60'>
      <div className='flex items-center gap-2 px-4 py-2' aria-busy='true'>
        <Skeleton className='size-4 shrink-0' />
        <div className='flex min-w-0 flex-col gap-1'>
          {name ? <span className='truncate text-sm font-medium text-muted-foreground'>{name}</span> : null}
          <Skeleton className='h-3 w-24' />
        </div>
      </div>
    </NodeCard>
  )
}
