'use client'

// What a node or an app instance shows while nothing provides its type: the
// extension it belongs to, read from its qualified type, and — when a connected
// registry lists that extension — an offer to install it. Installing brings the
// node or app back as it was; nothing about it was changed meanwhile.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'

import { installRegistryExtension } from '@/app/_authed/(extension-editor)/_actions/registry-actions'
import { extensionIdOfType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { registryListingOf } from '@/app/_authed/(extension-runtime)/_server/actions'

/** The state named in words: the missing extension when the type names one, the type itself when it names none. */
export function missingTypeLabel(type: string): string {
  const extensionId = extensionIdOfType(type)
  return extensionId ? `Missing extension ${extensionId}` : `Unknown type ${type}`
}

/**
 * An Install button for the extension `type` names, when a registry lists it;
 * nothing otherwise. The page reloads once the install lands, so every surface
 * holding the node or app picks up the extension together.
 */
export function InstallMissingExtension({ type, className }: { type: string; className?: string }) {
  const extensionId = extensionIdOfType(type)
  const [registryName, setRegistryName] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!extensionId) {
      return
    }
    let cancelled = false
    registryListingOf({ data: extensionId })
      .then((listing) => {
        if (!cancelled) {
          setRegistryName(listing?.registryName ?? null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [extensionId])

  if (!extensionId || !registryName) {
    return null
  }

  async function install() {
    setInstalling(true)
    try {
      await installRegistryExtension({ data: { extensionId: extensionId as string } })
      toast.success(`Installed ${extensionId}`)
      window.location.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setInstalling(false)
    }
  }

  return (
    <Button size='xs' variant='outline' className={className} disabled={installing} onClick={() => void install()}>
      {installing ? 'Installing…' : `Install from ${registryName}`}
    </Button>
  )
}
