'use client'

import { useEffect, useState, useTransition } from 'react'
import { ApiTokenCreateForm } from 'ui/auth/api-token-create-form'
import { type ApiToken, ApiTokenList } from 'ui/auth/api-token-list'
import { ApiTokenReveal } from 'ui/auth/api-token-reveal'
import { Button } from 'ui/button'
import { Spinner } from 'ui/spinner'

import { createMyToken, listMyTokens, type MyToken, revokeMyToken } from '@/app/(settings)/_server/token-actions'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

// Maps the server's MyToken -- ISO strings, explicit null for "not set" -- onto
// the kit's display-ready ApiToken. The kit component renders exactly what it
// is given and decides nothing about locale or what counts as expired; this is
// where those decisions actually get made.
function toDisplay(t: MyToken): ApiToken {
  return {
    id: t.id,
    name: t.name,
    createdAt: formatDate(t.createdAt),
    lastUsedAt: t.lastUsedAt ? formatDate(t.lastUsedAt) : undefined,
    expiresAt: t.expiresAt ? formatDate(t.expiresAt) : undefined,
    revoked: t.revokedAt != null,
    expired: t.expiresAt != null && new Date(t.expiresAt).getTime() <= Date.now(),
  }
}

type Panel = { kind: 'list' } | { kind: 'create' } | { kind: 'reveal'; name: string; token: string }

/**
 * A signed-in person's own API tokens: create, see, revoke.
 *
 * The server side already enforces the two properties that
 * stay non-negotiable regardless of anything this screen does — hash-only
 * storage and a token shown exactly once. This component's job is smaller:
 * hold the create → reveal → list sequence together, and translate the
 * server's raw values into what the kit's presentation-only components
 * expect.
 *
 * Errors shown here are ones this file's own server actions throw
 * deliberately (name required, expiry in the past, token not found) — not
 * raw library or database errors, which is why showing the message directly
 * is safe here in a way it would not be for, say, Better Auth's own errors.
 */
export default function TokenSettings() {
  const [tokens, setTokens] = useState<MyToken[]>([])
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  const reload = () => {
    setLoading(true)
    startTransition(async () => {
      setTokens(await listMyTokens())
      setLoading(false)
    })
  }

  useEffect(() => {
    reload()
  }, [])

  const onCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Name is required')
      return
    }
    setNameError(undefined)
    setFormError(undefined)
    startTransition(async () => {
      try {
        const created = await createMyToken({ data: { name: trimmed } })
        setName('')
        setCopied(false)
        setPanel({ kind: 'reveal', name: trimmed, token: created.token })
        reload()
      } catch (e) {
        setFormError(e instanceof Error ? e.message : 'Could not create the token')
      }
    })
  }

  const onRevoke = (id: string) => {
    setRevokingId(id)
    startTransition(async () => {
      await revokeMyToken({ data: { id } })
      setRevokingId(null)
      reload()
    })
  }

  const onCopy = () => {
    if (panel.kind !== 'reveal') {
      return
    }
    void navigator.clipboard.writeText(panel.token).then(() => setCopied(true))
  }

  const onDone = () => {
    setCopied(false)
    setPanel({ kind: 'list' })
  }

  return (
    <div className='p-6 space-y-6 max-w-3xl'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold flex items-center gap-2'>
            API tokens
            {pending && <Spinner className='size-5 text-muted-foreground' />}
          </h1>
          <p className='text-sm text-muted-foreground'>
            Personal credentials for scripts and integrations. Each can do everything your account can, including
            running commands on the host — treat one exactly like a password.
          </p>
        </div>
        {panel.kind === 'list' && <Button onClick={() => setPanel({ kind: 'create' })}>New token</Button>}
      </div>

      {panel.kind === 'create' && (
        <div className='rounded-lg border p-4 space-y-2'>
          <ApiTokenCreateForm
            name={name}
            onNameChange={setName}
            onSubmit={onCreate}
            nameError={nameError}
            error={formError}
            submitting={pending}
          />
          <Button variant='ghost' size='sm' onClick={() => setPanel({ kind: 'list' })}>
            Cancel
          </Button>
        </div>
      )}

      {panel.kind === 'reveal' && (
        <ApiTokenReveal token={panel.token} tokenName={panel.name} copied={copied} onCopy={onCopy} onDone={onDone} />
      )}

      {panel.kind === 'list' &&
        (loading ? (
          <div className='flex items-center justify-center gap-2 text-sm text-muted-foreground py-12'>
            <Spinner /> Loading tokens…
          </div>
        ) : (
          <ApiTokenList tokens={tokens.map(toDisplay)} onRevoke={onRevoke} revokingTokenId={revokingId} />
        ))}
    </div>
  )
}
