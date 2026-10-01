'use client'

import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type ReplacementChoice, type UnknownTypeEntry, UnknownTypes, unknownTypeKey } from 'ui/settings/unknown-types'
import { Spinner } from 'ui/spinner'

import { installRegistryExtension } from '@/app/_authed/(extension-editor)/_actions/registry-actions'
import type { ReplaceableKind, TypeScan } from '@/app/_authed/(settings)/_server/unknown-types'
import {
  listUnknownTypes,
  planUnknownTypeReplacement,
  replaceUnknownType,
} from '@/app/_authed/(settings)/_server/unknown-types-actions'

// The page is the kit's UnknownTypes; what stays here is the scan, the
// install, the replace and the toasts.

function replaceRequest(entry: UnknownTypeEntry, to: string): { kind: ReplaceableKind; from: string; to: string } {
  if (entry.kind === 'handle') {
    throw new Error('A handle type can only be installed')
  }
  return { kind: entry.kind, from: entry.type, to }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function UnknownTypesSettings() {
  const router = useRouter()
  const [scan, setScan] = useState<TypeScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [installing, setInstalling] = useState<string>()
  const [installingAll, setInstallingAll] = useState(false)
  const [replacing, setReplacing] = useState<string>()
  const [replacingAll, setReplacingAll] = useState(false)

  const rescan = useCallback(async () => {
    setScanning(true)
    try {
      setScan(await listUnknownTypes())
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void rescan()
  }, [rescan])

  async function install(entry: UnknownTypeEntry) {
    if (!entry.install) {
      return
    }
    setInstalling(unknownTypeKey(entry))
    try {
      await installRegistryExtension({ data: { extensionId: entry.install.extensionId } })
      toast.success(`Installed ${entry.install.extensionId}`)
      await rescan()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setInstalling(undefined)
    }
  }

  // One at a time: each install builds its extension, and a failed one does
  // not stop the rest.
  async function installAll(extensionIds: string[]) {
    setInstallingAll(true)
    const failed: string[] = []
    for (const extensionId of extensionIds) {
      try {
        await installRegistryExtension({ data: { extensionId } })
      } catch (error) {
        failed.push(`${extensionId}: ${errorText(error)}`)
      }
    }
    const installed = extensionIds.length - failed.length
    if (failed.length > 0) {
      toast.error(`Installed ${installed} of ${extensionIds.length}. Failed:\n${failed.join('\n')}`)
    } else {
      toast.success(`Installed ${installed}`)
    }
    setInstallingAll(false)
    await rescan()
  }

  // The uses of one type that were rewritten, and the places that were not,
  // each named with where it is.
  async function replaceOne({ entry, to }: ReplacementChoice): Promise<{ replaced: number; failed: string[] }> {
    try {
      const result = await replaceUnknownType({ data: replaceRequest(entry, to) })
      return {
        replaced: result.replaced,
        failed: result.failures.map((failure) => `${entry.type} at ${failure.location}: ${failure.error}`),
      }
    } catch (error) {
      return { replaced: 0, failed: [`${entry.type}: ${errorText(error)}`] }
    }
  }

  function report(replaced: number, failed: string[]) {
    if (failed.length === 0) {
      toast.success(`Replaced ${replaced}`)
    } else if (replaced === 0) {
      toast.error(`Nothing replaced:\n${failed.join('\n')}`)
    } else {
      toast.warning(`Replaced ${replaced}. Not replaced:\n${failed.join('\n')}`)
    }
  }

  async function replace(choice: ReplacementChoice) {
    setReplacing(unknownTypeKey(choice.entry))
    const { replaced, failed } = await replaceOne(choice)
    report(replaced, failed)
    setReplacing(undefined)
    await rescan()
  }

  // One type at a time, like install all: a failed one does not stop the rest,
  // and the list is scanned once at the end.
  async function replaceAll(choices: ReplacementChoice[]) {
    setReplacingAll(true)
    let replaced = 0
    const failed: string[] = []
    for (const choice of choices) {
      const result = await replaceOne(choice)
      replaced += result.replaced
      failed.push(...result.failed)
    }
    report(replaced, failed)
    setReplacingAll(false)
    await rescan()
  }

  if (!scan) {
    return <Spinner className='mx-auto' />
  }

  return (
    <UnknownTypes
      types={scan.unknown}
      replacements={scan.replacements}
      unreachableRegistries={scan.unreachableRegistries}
      scanning={scanning}
      installing={installing}
      installingAll={installingAll}
      replacing={replacing}
      replacingAll={replacingAll}
      onRescan={() => void rescan()}
      onInstall={(entry) => void install(entry)}
      onInstallAll={(extensionIds) => void installAll(extensionIds)}
      onPlanReplace={(entry, to) => planUnknownTypeReplacement({ data: replaceRequest(entry, to) })}
      onReplace={(choice) => void replace(choice)}
      onReplaceAll={(choices) => void replaceAll(choices)}
      onNavigate={(href) => router.navigate({ to: href })}
    />
  )
}
