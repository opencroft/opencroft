'use client'

import { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'

import { listSecretStores, type SecretStoreSummary } from '@/app/_authed/(secrets-store)/_server/actions'

const NONE = '__none__'

/**
 * Encode/decode a `SecretSelector` value. The selected KEY is addressed as
 * `<storeId>/<key>` in one string, so it can live anywhere a plain string
 * can (an App parameter, a node's data field). Key names may contain `/`;
 * store ids do not, so the split is on the first one.
 */
export function parseSecretRef(value: string): { storeId: string; key: string } | null {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    return null
  }
  return { storeId: value.slice(0, slash), key: value.slice(slash + 1) }
}

export interface SecretSelectorProps {
  /** `<storeId>/<key>` of the selected secret, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one secret KEY from the Secrets Stores. Only key addresses cross this
 * component — never values. Also exposed to extension client code via
 * `@opencroft/client`.
 */
export function SecretSelector({ value, onChange, allowNone, placeholder, disabled }: SecretSelectorProps) {
  const [stores, setStores] = useState<SecretStoreSummary[]>([])

  useEffect(() => {
    listSecretStores()
      .then(setStores)
      .catch(() => setStores([]))
  }, [])

  const options = stores.flatMap((store) =>
    store.keys.map((key) => ({
      value: `${store.storeId}/${key}`,
      label: `Secret ${store.storeId.slice(-6)} / ${key}`,
    })),
  )

  return (
    <Select
      value={value || (allowNone ? NONE : undefined)}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? 'Select a secret'} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>None</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
