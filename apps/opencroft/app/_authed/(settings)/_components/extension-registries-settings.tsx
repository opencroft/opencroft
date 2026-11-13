'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  ExtensionRegistries,
  type ExtensionRegistryDraft,
  type ExtensionRegistryEntry,
} from 'ui/settings/extension-registries'
import { Spinner } from 'ui/spinner'

import type { SecretChoice, SecretRef } from '@/app/_authed/(extension-runtime)/_server/registry-settings'
import { parseSecretRef } from '@/app/_authed/(secrets-store)/_components/secret-selector'
import {
  checkExtensionRegistry,
  type ExtensionRegistryRow,
  listExtensionRegistries,
  listRegistrySecretChoices,
  removeExtensionRegistry,
  saveExtensionRegistry,
} from '@/app/_authed/(settings)/_server/extension-registries-actions'

// The page is the kit's ExtensionRegistries; what stays here is reading the
// list and the secrets, and turning the kit's secret references, one string
// each, into the store and key the server takes.

function refString(ref: SecretRef | undefined): string | undefined {
  return ref ? `${ref.storeId}/${ref.key}` : undefined
}

function refOf(value: string | undefined): SecretRef | undefined {
  return value ? (parseSecretRef(value) ?? undefined) : undefined
}

function toInput(draft: ExtensionRegistryDraft, id?: string) {
  return {
    ...(id ? { id } : {}),
    repository: draft.repository,
    username: refOf(draft.username),
    password: refOf(draft.password),
  }
}

function toEntry(row: ExtensionRegistryRow): ExtensionRegistryEntry {
  return {
    key: row.id ?? `${row.origin}:${row.repository}`,
    origin: row.origin,
    repository: row.repository,
    needsCredentials: row.needsCredentials,
    username: refString(row.username),
    password: refString(row.password),
    extensions: row.extensions,
    error: row.error,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function ExtensionRegistriesSettings() {
  const [rows, setRows] = useState<ExtensionRegistryRow[] | null>(null)
  const [choices, setChoices] = useState<SecretChoice[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [registries, secrets] = await Promise.all([listExtensionRegistries(), listRegistrySecretChoices()])
      setRows(registries)
      setChoices(secrets)
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const labels = useMemo(
    () => new Map(choices.map((choice) => [`${choice.storeId}/${choice.key}`, `${choice.store} · ${choice.key}`])),
    [choices],
  )

  async function handleSave(draft: ExtensionRegistryDraft, key?: string) {
    const id = rows?.find((row) => row.id === key)?.id
    await saveExtensionRegistry({ data: toInput(draft, id) })
    toast.success(id ? `Saved ${draft.repository.trim()}` : `Added ${draft.repository.trim()}`)
    await refresh()
  }

  async function handleRemove(key: string) {
    try {
      await removeExtensionRegistry({ data: key })
      toast.success('Registry removed')
    } catch (error) {
      toast.error(errorText(error))
    }
    await refresh()
  }

  if (!rows) {
    return <Spinner className='mx-auto' />
  }

  return (
    <ExtensionRegistries
      registries={rows.map(toEntry)}
      secrets={[...labels.keys()]}
      secretLabel={(secret) => labels.get(secret) ?? secret}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      onCheck={(draft) => checkExtensionRegistry({ data: toInput(draft) })}
      onSave={handleSave}
      onRemove={handleRemove}
    />
  )
}
