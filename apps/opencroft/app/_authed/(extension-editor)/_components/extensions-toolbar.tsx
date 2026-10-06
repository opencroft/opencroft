'use client'

import { CircleArrowUp, Download, Plus, Search } from 'lucide-react'
import { CountBadge } from 'ui/count-badge'
import { Input } from 'ui/input'
import { TitleBarIconButton } from 'ui/layouts/title-bar'

interface ExtensionsToolbarProps {
  /** The registry search; the page's main pane shows its results while it is not empty. */
  query: string
  onQueryChange: (query: string) => void
  /** How many updates can be taken now: the updates button's badge. */
  updatesAvailable: number
  onInstall: () => void
  onNew: () => void
  onShowUpdates: () => void
}

// The Extensions page's row in the title bar's toolbar: the search in the
// middle, the page's acts on the right. The outer columns share the width
// equally, so the search stays centred on the bar whatever the acts take.
export function ExtensionsToolbar({
  query,
  onQueryChange,
  updatesAvailable,
  onInstall,
  onNew,
  onShowUpdates,
}: ExtensionsToolbarProps) {
  const updatesLabel = updatesAvailable > 0 ? `Updates, ${updatesAvailable} available` : 'Updates'
  return (
    <div className='grid w-full grid-cols-[1fr_minmax(0,24rem)_1fr] items-center gap-2'>
      <div />
      <div className='relative'>
        <Search className='pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground' />
        <Input
          type='search'
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder='Search extensions...'
          aria-label='Search extensions'
          className='h-7 pl-7 text-xs'
        />
      </div>
      <div className='flex items-center justify-end gap-1'>
        <TitleBarIconButton aria-label='Install from URL' title='Install from URL' onClick={onInstall}>
          <Download />
        </TitleBarIconButton>
        <TitleBarIconButton aria-label='New local extension' title='New local extension' onClick={onNew}>
          <Plus />
        </TitleBarIconButton>
        <TitleBarIconButton aria-label={updatesLabel} title={updatesLabel} className='relative' onClick={onShowUpdates}>
          <CircleArrowUp />
          <CountBadge count={updatesAvailable} />
        </TitleBarIconButton>
      </div>
    </div>
  )
}
