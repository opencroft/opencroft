'use client'

import { useNodes } from '@xyflow/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Label } from 'ui/label'
import { EnvironmentTable } from 'ui/nodes/environment-table'
import { SecretValueField as KitSecretValueField } from 'ui/nodes/secret-value-field'

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  type CredentialHolder,
  isSecret,
  type NamedValue,
  readNamedValues,
  readSecretValue,
  storeNamedValues,
  storeSecretValue,
  typedCredentialSentence,
  typedCredentialWarning,
} from '@/app/_authed/(secrets-store)/_lib/secret-values'
import { listSpaceSecretNames } from '@/app/_authed/(secrets-store)/_server/actions'

const NO_GRAPH_SECRETS = 'No Secrets Stores in this graph. Add a Secrets Store node and define keys to pick from.'
const NO_SPACE_SECRETS =
  'No secrets in this space. Add a Secrets Store node to a graph of this space and define keys to pick from.'

/** The names a field offers and what it says around them, for where the field is. */
interface SecretNames {
  /** Undefined while they load. */
  names: string[] | undefined
  noSecretsMessage: string
  holder: CredentialHolder
}

// The secret names the graph's Secrets Store nodes declare. The node's own
// `secretKeys` list is what its inspector shows and what the store holds, and
// only names are read: no value reaches the browser.
function useGraphSecretNames(): string[] {
  const nodes = useNodes()
  return useMemo(() => {
    const names = new Set<string>()
    for (const node of nodes) {
      if (parseType(node.type ?? '')?.bare !== 'core-secrets-store') {
        continue
      }
      const keys = (node.data as { secretKeys?: unknown }).secretKeys
      for (const key of Array.isArray(keys) ? keys : []) {
        if (typeof key === 'string') {
          names.add(key)
        }
      }
    }
    return [...names].sort()
  }, [nodes])
}

// The secret names of the space's Secrets Stores, the ones an App's value resolves from. Read once
// per mount: an App's form opens fresh each time, so a secret added meanwhile shows on the next open.
function useSpaceSecretNames(spaceSlug: string): string[] | undefined {
  const [names, setNames] = useState<string[]>()
  useEffect(() => {
    let current = true
    setNames(undefined)
    listSpaceSecretNames({ data: spaceSlug })
      .then((found) => current && setNames(found))
      .catch(() => current && setNames([]))
    return () => {
      current = false
    }
  }, [spaceSlug])
  return names
}

function GraphSecretNames({ children }: { children: (source: SecretNames) => ReactNode }) {
  return children({ names: useGraphSecretNames(), noSecretsMessage: NO_GRAPH_SECRETS, holder: 'node' })
}

function SpaceSecretNames({
  spaceSlug,
  children,
}: {
  spaceSlug: string
  children: (source: SecretNames) => ReactNode
}) {
  return children({ names: useSpaceSecretNames(spaceSlug), noSecretsMessage: NO_SPACE_SECRETS, holder: 'app' })
}

// A node's field sits in a graph and offers its stores; an App's field names its space. Two
// components, because each source is read through its own hook and `useNodes` needs a graph.
function WithSecretNames({
  spaceSlug,
  children,
}: {
  spaceSlug: string | undefined
  children: (source: SecretNames) => ReactNode
}) {
  return spaceSlug ? (
    <SpaceSecretNames spaceSlug={spaceSlug}>{children}</SpaceSecretNames>
  ) : (
    <GraphSecretNames>{children}</GraphSecretNames>
  )
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
   * Whether a value can be typed (default). Without it the field only takes a secret, or none
   * (''), for a field whose value must never sit in the node.
   */
  allowTyped?: boolean
  /**
   * For a field on an App's page: the App's space. Its secrets are picked from the Secrets Stores
   * on every graph of the space, the ones `secrets.resolveValue(value, { spaceSlug })` reads.
   * Without it the field is in a node's inspector and offers its graph's stores.
   */
  spaceSlug?: string
}

/**
 * One field that holds a credential (an API key, a password). The value is
 * typed or a secret picked by name, stored as `secret:<NAME>` and resolved
 * server-side with `secrets.resolveValue`. Any typed value is flagged: this
 * field holds a credential, so a typed one is readable by anyone who reads
 * the node or the App's settings.
 */
export function SecretValueField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  allowTyped,
  spaceSlug,
}: SecretValueFieldProps) {
  const current = readSecretValue(value)
  const typed = 'value' in current && current.value.trim() !== ''
  return (
    <WithSecretNames spaceSlug={spaceSlug}>
      {({ names, noSecretsMessage, holder }) => (
        <KitSecretValueField
          label={label}
          value={current}
          // Until the names load, the picked one counts as found rather than flashing as missing.
          secrets={names ?? (isSecret(current) ? [current.secret] : [])}
          onChange={(next) => onChange(storeSecretValue(next))}
          warning={typed ? typedCredentialSentence(label, holder) : undefined}
          noSecretsMessage={noSecretsMessage}
          placeholder={placeholder}
          disabled={disabled}
          allowTyped={allowTyped}
          concealed
        />
      )}
    </WithSecretNames>
  )
}

export interface SecretValueTableProps {
  /** What the list is, above the table: "Request headers". */
  label: string
  /** What one row is: "Header", "Variable". */
  nameLabel: string
  namePlaceholder?: string
  /** As the node stores them: `{ name, value }`, a value typed or `secret:<NAME>`. */
  entries: NamedValue[] | undefined
  /** The stored form after a change. */
  onChange: (entries: NamedValue[]) => void
  disabled?: boolean
  /** For a table on an App's page: the App's space, as `SecretValueField` takes it. */
  spaceSlug?: string
}

/**
 * A list of names and values that may take secrets: request headers,
 * environment variables. A value is typed or a secret picked by name, stored
 * as `secret:<NAME>`; a typed value that looks like a credential is flagged.
 */
export function SecretValueTable({
  label,
  nameLabel,
  namePlaceholder,
  entries,
  onChange,
  disabled,
  spaceSlug,
}: SecretValueTableProps) {
  const rows = useMemo(() => readNamedValues(entries), [entries])
  return (
    <div className='flex flex-col gap-1'>
      <Label>{label}</Label>
      <WithSecretNames spaceSlug={spaceSlug}>
        {({ names, noSecretsMessage, holder }) => (
          <EnvironmentTable
            nameLabel={nameLabel}
            namePlaceholder={namePlaceholder}
            variables={rows}
            // Until the names load, the picked ones count as found rather than flashing as missing.
            secrets={names ?? rows.flatMap((row) => (isSecret(row) ? [row.secret] : []))}
            onChange={(next) => onChange(storeNamedValues(next))}
            valueWarning={(entry) => typedCredentialWarning(entry, holder)}
            noSecretsMessage={noSecretsMessage}
            disabled={disabled}
          />
        )}
      </WithSecretNames>
    </div>
  )
}
