/**
 * `@opencroft/client/secrets` — choosing a secret from the host's Secrets
 * Stores without the value ever reaching the browser.
 */
import type { FC } from 'react'

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
 * Pick one secret KEY from the host's Secrets Stores. Only the key's address
 * (`<storeId>/<key>`) crosses the component — never the value; resolve it
 * server-side with `secrets.get(storeId, key)` from `@opencroft/server/secrets`.
 */
export declare const SecretSelector: FC<SecretSelectorProps>
