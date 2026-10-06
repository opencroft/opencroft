'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ExtensionSearchResults } from 'ui/extensions/extension-search-results'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import {
  installRegistryExtension,
  listRegistryExtensions,
} from '@/app/_authed/(extension-editor)/_actions/registry-actions'
import {
  hitKey,
  installedFolders,
  type RegistryHit,
  searchResults,
} from '@/app/_authed/(extension-editor)/_components/registry-search'

interface RegistrySearchResultsProps {
  /** The search typed in the page's toolbar; not empty while this is shown. */
  query: string
  installed: ExtensionIndexEntry[]
  /** An install landed: the folder it went into. */
  onInstalled: (folder: string) => void
  onOpen: (folder: string) => void
  className?: string
}

// What the registries offer for the page's search. Asked once typing pauses;
// an answer to a query that has since changed is dropped, so a slow early
// search cannot overwrite a later one.
export function RegistrySearchResults({
  query,
  installed,
  onInstalled,
  onOpen,
  className,
}: RegistrySearchResultsProps) {
  const [hits, setHits] = useState<RegistryHit[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const term = query.trim()

  useEffect(() => {
    let active = true
    setSearching(true)
    const timer = setTimeout(() => {
      listRegistryExtensions({ data: term })
        .then((results) => {
          if (active) {
            setHits(results)
          }
        })
        .catch(() => {
          if (active) {
            toast.error('Failed to search registries')
          }
        })
        .finally(() => {
          if (active) {
            setSearching(false)
          }
        })
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [term])

  const folders = useMemo(() => installedFolders(installed), [installed])
  const hitFor = (key: string) => hits.find((hit) => hitKey(hit) === key)

  async function install(key: string) {
    const hit = hitFor(key)
    if (!hit) {
      return
    }
    setInstalling(key)
    try {
      const { folder } = await installRegistryExtension({ data: { extensionId: hit.id } })
      toast.success(`Installed ${hit.name}`)
      onInstalled(folder)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  function open(key: string) {
    const hit = hitFor(key)
    const folder = hit ? folders.get(hit.repository) : undefined
    if (folder) {
      onOpen(folder)
    }
  }

  return (
    <ExtensionSearchResults
      className={className}
      results={searchResults(hits, folders, installing)}
      searching={searching}
      onInstall={(key) => void install(key)}
      onOpen={open}
    />
  )
}
