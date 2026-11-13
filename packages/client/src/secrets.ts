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

/** One name/value pair of a list that may take secrets: request headers, environment variables. */
export interface NamedValue {
  name: string
  /** Typed text, or `secret:<NAME>`. */
  value: string
}

export interface SecretValueFieldProps {
  /** What the value is, above the field. */
  label: string
  /** As the node stores it: typed text or `secret:<NAME>`. */
  value: string | undefined
  /** The stored form after a change. */
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /**
   * Whether a value can be typed (default). Without it the field only takes a
   * secret, stored as `secret:<NAME>`, or none (''), and shows `placeholder`
   * until one is picked: for a field whose value must never sit in the node.
   */
  allowTyped?: boolean
  /**
   * For a field on an App's page: the App's space. Its secrets are picked from
   * the Secrets Stores on every graph of the space; resolve the value with
   * `secrets.resolveValue(value, { spaceSlug })`. Without it the field is in a
   * node's inspector and offers the stores on the node's graph.
   */
  spaceSlug?: string
}

/**
 * One field that holds a credential (an API key, a password): typed, or a
 * secret picked by name from the Secrets Stores of the node's graph or the
 * App's space. A secret is stored as `secret:<NAME>`, never its value; resolve
 * it where it is used with `secrets.resolveValue` from
 * `@opencroft/server/secrets`, in the same scope. A typed value is flagged,
 * since anyone who reads the node or the App's settings reads it.
 */
export declare const SecretValueField: FC<SecretValueFieldProps>

export interface SecretValueTableProps {
  /** What the list is, above the table: "Request headers". */
  label: string
  /** What one row is: "Header", "Variable". */
  nameLabel: string
  namePlaceholder?: string
  /** As the node stores them: a value typed or `secret:<NAME>`. */
  entries: NamedValue[] | undefined
  /** The stored form after a change. */
  onChange: (entries: NamedValue[]) => void
  disabled?: boolean
  /** For a table on an App's page: the App's space, as `SecretValueField` takes it. */
  spaceSlug?: string
}

/**
 * A node's names and values that may take secrets (request headers,
 * environment variables), as one table. Stored and resolved as
 * `SecretValueField` is; a typed value that looks like a credential is flagged.
 */
export declare const SecretValueTable: FC<SecretValueTableProps>
