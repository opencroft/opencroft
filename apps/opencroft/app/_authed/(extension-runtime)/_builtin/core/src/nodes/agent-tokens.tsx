import { legacy } from '@opencroft/client'

const { ApiTokenCreateForm, ApiTokenList, ApiTokenReveal, Button, React, ScrollArea, Spinner, invoke, toast } = legacy

const { useCallback, useEffect, useState } = React

// What agent.listMcpTokens returns — ISO strings, null for "not set".
interface McpToken {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

// Offered in this order, with a finite lifetime selected by default: "never" is
// a choice somebody makes, not what an untouched form produces.
const LIFETIMES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
]
const DEFAULT_LIFETIME = '90'

function expiresAtFor(lifetime: string): string | null {
  return lifetime === 'never' ? null : new Date(Date.now() + Number(lifetime) * DAY_MS).toISOString()
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

// The kit list renders display-ready values and decides nothing about locale or
// what counts as expired; those decisions are made here. A deleted token is
// gone from the list rather than shown revoked, so `revoked` is never set.
function toDisplay(token: McpToken) {
  return {
    id: token.id,
    name: token.name,
    createdAt: formatDate(token.createdAt),
    lastUsedAt: token.lastUsedAt ? formatDate(token.lastUsedAt) : undefined,
    expiresAt: token.expiresAt ? formatDate(token.expiresAt) : undefined,
    expired: token.expiresAt != null && new Date(token.expiresAt).getTime() <= Date.now(),
  }
}

type Panel = { kind: 'list' } | { kind: 'create' } | { kind: 'reveal'; name: string; token: string }

/**
 * This agent's MCP tokens: the credentials an external MCP client presents to
 * act as this agent. Create (named, with a lifetime), see once, delete.
 */
export function AgentTokensTab({ nodeId }: { nodeId: string }) {
  const [tokens, setTokens] = useState<McpToken[]>([])
  const [loading, setLoading] = useState(true)
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState(DEFAULT_LIFETIME)
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const reload = useCallback(async () => {
    try {
      setTokens(await invoke<McpToken[]>('agent.listMcpTokens', nodeId))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load tokens')
    } finally {
      setLoading(false)
    }
  }, [nodeId])

  useEffect(() => {
    void reload()
  }, [reload])

  const onCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Name is required')
      return
    }
    setNameError(undefined)
    setFormError(undefined)
    setSubmitting(true)
    try {
      const created = await invoke<{ id: string; token: string }>('agent.createMcpToken', nodeId, {
        name: trimmed,
        expiresAt: expiresAtFor(lifetime),
      })
      setName('')
      setLifetime(DEFAULT_LIFETIME)
      setCopied(false)
      setPanel({ kind: 'reveal', name: trimmed, token: created.token })
      await reload()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not create the token')
    } finally {
      setSubmitting(false)
    }
  }

  const onDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await invoke('agent.deleteMcpToken', nodeId, id)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the token')
    } finally {
      setDeletingId(null)
    }
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
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <p className='text-[10px] text-muted-foreground'>
          An MCP client connects to <span className='font-mono'>{window.location.origin}/mcp</span> with{' '}
          the header <span className='font-mono'>X-API-Key: &lt;token&gt;</span> (or{' '}
          <span className='font-mono'>Authorization: Bearer &lt;token&gt;</span>) and acts as this agent — including
          running commands on the hosts this agent can reach. Treat a token like a password.
        </p>

        {panel.kind === 'list' && (
          <Button size='sm' onClick={() => setPanel({ kind: 'create' })}>
            New token
          </Button>
        )}

        {panel.kind === 'create' && (
          <div className='flex flex-col gap-2 rounded-md border p-2.5'>
            <ApiTokenCreateForm
              name={name}
              onNameChange={setName}
              expiryOptions={LIFETIMES}
              expiry={lifetime}
              onExpiryChange={setLifetime}
              onSubmit={onCreate}
              nameError={nameError}
              error={formError}
              submitting={submitting}
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
            <div className='flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground'>
              <Spinner /> Loading tokens…
            </div>
          ) : (
            <ApiTokenList tokens={tokens.map(toDisplay)} onRevoke={onDelete} revokingTokenId={deletingId} />
          ))}
      </div>
    </ScrollArea>
  )
}
