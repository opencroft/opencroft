'use client'

import { Check, Download } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from 'ui/components/ui/item'
import { Spinner } from 'ui/components/ui/spinner'
import { cn } from 'cn'

/** Where one result stands on this instance. */
export type ExtensionSearchResultState = 'available' | 'installing' | 'installed'

export interface ExtensionSearchResult {
  /** The host's own id for the result, handed back on press. */
  id: string
  name: string
  description?: string
  /** The registry that lists it. */
  source: string
  state: ExtensionSearchResultState
}

export interface ExtensionSearchResultsProps {
  results: ExtensionSearchResult[]
  /** The search is still answering. */
  searching?: boolean
  onInstall: (id: string) => void
  /** Opens an installed result. Without it an installed name is plain text. */
  onOpen?: (id: string) => void
  className?: string
}

function ResultName({ result, onOpen }: { result: ExtensionSearchResult; onOpen?: (id: string) => void }) {
  if (result.state !== 'installed' || !onOpen) {
    return <span className='truncate'>{result.name}</span>
  }
  return (
    <button type='button' onClick={() => onOpen(result.id)} className='truncate text-left hover:underline'>
      {result.name}
    </button>
  )
}

function InstallAction({
  result,
  installing,
  onInstall,
}: {
  result: ExtensionSearchResult
  installing: boolean
  onInstall: (id: string) => void
}) {
  if (result.state === 'installed') {
    return (
      <span className='flex items-center gap-1 text-xs text-muted-foreground'>
        <Check className='size-3.5' />
        Installed
      </span>
    )
  }
  if (result.state === 'installing') {
    return (
      <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
        <Spinner className='size-3.5' />
        Installing…
      </span>
    )
  }
  return (
    <Button type='button' size='sm' variant='outline' disabled={installing} onClick={() => onInstall(result.id)}>
      <Download className='size-3.5' />
      Install
    </Button>
  )
}

// What the registries offer for a search, with room for what each extension
// is: a result is read before it is installed, and its description is what
// tells two similar names apart. One install runs at a time, so while one is
// on every other Install waits for it.
export function ExtensionSearchResults({
  results,
  searching = false,
  onInstall,
  onOpen,
  className,
}: ExtensionSearchResultsProps) {
  const installing = results.some((result) => result.state === 'installing')

  return (
    <div data-slot='extension-search-results' className={cn('flex w-full flex-col gap-4', className)}>
      <div className='flex items-center gap-2'>
        <h2 className='text-base font-semibold'>Search results</h2>
        {searching && results.length > 0 ? <Spinner className='size-3.5 text-muted-foreground' /> : null}
      </div>

      {results.length === 0 ? (
        searching ? (
          <span className='flex items-center gap-2 py-6 text-sm text-muted-foreground'>
            <Spinner className='size-4' />
            Searching the registries…
          </span>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No extensions found</EmptyTitle>
              <EmptyDescription>No registry lists an extension that matches this search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <ItemGroup className='gap-2'>
          {results.map((result) => (
            <Item key={result.id} variant='outline' size='sm'>
              <ItemContent className='min-w-0'>
                <ItemTitle className='min-w-0 max-w-full'>
                  <ResultName result={result} onOpen={onOpen} />
                </ItemTitle>
                {result.description ? (
                  <ItemDescription className='text-xs'>{result.description}</ItemDescription>
                ) : null}
                <span className='text-[10px] text-muted-foreground'>{result.source}</span>
              </ItemContent>
              <ItemActions>
                <InstallAction result={result} installing={installing} onInstall={onInstall} />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  )
}
