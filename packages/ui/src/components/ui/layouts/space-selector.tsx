import { cn } from 'cn'
import { LayoutGrid } from 'lucide-react'

import { SpaceIcon } from '../spaces/space-icon'

export interface SelectorSpace {
  slug: string
  name: string
  /** The stored icon, drawn by Space Icon: `preset:<glyph>:<colour>` or an image URL. */
  icon: string
  pinned?: boolean
}

/** A space's icon, or the grid glyph that stands for all spaces while none is open. */
export function SpaceSelectorIcon({ icon, className }: { icon?: string; className?: string }) {
  if (icon) {
    return <SpaceIcon icon={icon} className={className} />
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center', className)}>
      <LayoutGrid className='size-[80%]' />
    </span>
  )
}
