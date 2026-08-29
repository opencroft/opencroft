'use client'

// The embeddable group-chat thread, for extension surfaces (exposed through
// the extension host API). `space` names a group chat by slug, `id` names one
// thread per member agent inside it — together with the picked agent they
// address the SAME thread the group-chats UI shows, through the same shared
// assembly (GroupChatThreadChat) the thread route renders. Nothing here is a
// second chat implementation: this component only resolves which thread the
// (space, agent, id) triple means and puts the shared assembly on screen.
//
// The lifecycle, by state:
//   - chat missing        → an empty state offering to create it (the caller
//                           picks users and agents; creation is the same
//                           membership model the group-chats UI uses).
//   - caller not a member → the same collapsed refusal the thread route shows.
//   - no thread yet       → the kit's start-thread composer (its agent picker
//                           doubles as this surface's picker); the first send
//                           creates the thread through the membership-checked
//                           startThread path, titled with `id` so the slug —
//                           and so the session key's tail — reads as the id.
//   - thread exists       → the shared assembly reattaches to it; the picker
//                           moves into the composer's leading slot.

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { AgentPicker } from 'ui/group-chat/agent-picker'
import { StartThreadComposer } from 'ui/group-chat/start-thread-composer'
import { Spinner } from 'ui/spinner'

import { wrapUserSelection } from '@/app/_authed/(agent)/_shared/message-envelope'
import { SelectionBadge } from '@/app/_authed/(extension-runtime)/_client/selection-badge'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatThreadChat } from '@/app/_authed/(group-chats)/_components/group-chat-thread-chat'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import type {
  DirectoryUser,
  GroupChatDetailView,
  GroupChatEmbedView,
  GroupChatThreadEntry,
} from '@/app/_authed/(group-chats)/_server/actions'
import {
  addGroupChatMember,
  createMyGroupChat,
  findGroupChatEmbedThread,
  getGroupChatEmbedView,
  listDirectoryUsersForPicker,
  startGroupChatThread,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'
import { listAgentNodes } from '@/app/_authed/(space)/_server/agents'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'
import { cn } from '@/lib/utils'

export interface EmbeddedAgentChatProps {
  /** The group chat's slug — the first segment of every thread session key. */
  space: string
  /** The thread slug this surface owns, one per member agent. */
  id: string
  /**
   * What to NAME the chat if this surface has to create it. The address is
   * always `space`; this is only the display name, and it defaults to the slug
   * when a host has no better one.
   *
   * A host that has both — a space knows its name and its slug — should pass
   * it, because deriving the name from the slug puts "my-space" in front of a
   * person where "My Space" was meant.
   */
  title?: string
  className?: string
}

type EmbedPhase =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'refused'; view: Extract<GroupChatEmbedView, { state: 'refused' }> }
  | { phase: 'ready'; chat: GroupChatDetailView }
  | { phase: 'error'; message: string }

export function EmbeddedAgentChat({ space, id, title, className }: EmbeddedAgentChatProps) {
  const [state, setState] = useState<EmbedPhase>({ phase: 'loading' })
  // Bumped to reload after the create flow finishes — the cheapest way to go
  // from `missing` to `ready` through the same single load path.
  const [loadTick, setLoadTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies(loadTick): not read in the body — it exists to re-run this load after the create flow finishes
  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    getGroupChatEmbedView({ data: space })
      .then((view) => {
        if (cancelled) {
          return
        }
        if (view.state === 'missing') {
          setState({ phase: 'missing' })
        } else if (view.state === 'refused') {
          setState({ phase: 'refused', view })
        } else {
          setState({ phase: 'ready', chat: view.chat })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ phase: 'error', message: failureMessage(error, 'This chat could not be loaded.') })
        }
      })
    return () => {
      cancelled = true
    }
  }, [space, loadTick])

  const reload = useCallback(() => setLoadTick((tick) => tick + 1), [])

  switch (state.phase) {
    case 'loading':
      return <CenteredSpinner className={className} />
    case 'error':
      return (
        <Empty className={cn('h-full', className)}>
          <EmptyHeader>
            <EmptyTitle>Something went wrong</EmptyTitle>
            <EmptyDescription>{state.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )
    case 'refused':
      return (
        <div className={cn('flex h-full min-h-0 flex-col justify-center', className)}>
          <GroupChatRefusal code={state.view.code} />
        </div>
      )
    case 'missing':
      return <CreateChatEmptyState space={space} title={title} className={className} onCreated={reload} />
    case 'ready':
      return <EmbeddedThread chat={state.chat} id={id} className={className} />
  }
}

function CenteredSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className='flex h-full min-h-24 items-center justify-center'>
        <Spinner className='size-5 text-muted-foreground' />
      </div>
    </div>
  )
}

// ── The thread surface, once the chat resolved ───────────────────────────

function EmbeddedThread({ chat, id, className }: { chat: GroupChatDetailView; id: string; className?: string }) {
  // MEMBER agents only: any other agent is refused by startThread, so
  // offering one would be offering a choice that cannot succeed.
  const memberAgents = useMemo(
    () =>
      chat.members
        .filter((m) => m.kind === 'agent')
        .map((m) => ({ nodeId: m.id, name: m.name, avatarUrl: m.avatarUrl })),
    [chat.members],
  )

  // Remembered per group chat, under the same key the group-chat screen's own
  // start composer uses — who you usually address in a chat is one fact, not
  // one per surface. Falls back to the first member agent when unset or stale.
  const [rememberedAgent, setRememberedAgent] = useLocalStorage<string | null>(
    `opencroft.groupChat.${chat.id}.lastAgent`,
    null,
  )
  const selectedAgent =
    rememberedAgent && memberAgents.some((a) => a.nodeId === rememberedAgent)
      ? rememberedAgent
      : (memberAgents[0]?.nodeId ?? null)

  // The picked agent's thread for this id: undefined = still resolving,
  // null = the first send will create it.
  const [thread, setThread] = useState<(GroupChatThreadEntry & { draft: string | null }) | null | undefined>(undefined)
  const [threadError, setThreadError] = useState<string>()
  const [threadTick, setThreadTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies(threadTick): not read in the body — it exists to re-resolve the thread after the first send creates it
  useEffect(() => {
    if (!selectedAgent) {
      setThread(null)
      return
    }
    let cancelled = false
    setThread(undefined)
    setThreadError(undefined)
    findGroupChatEmbedThread({ data: { groupChatId: chat.id, agentNodeId: selectedAgent, id } })
      .then((entry) => {
        if (!cancelled) {
          setThread(entry)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setThread(null)
          setThreadError(failureMessage(error, 'This thread could not be loaded.'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [chat.id, selectedAgent, id, threadTick])

  const onThreadStarted = useCallback(() => setThreadTick((tick) => tick + 1), [])

  // The kit's own picker — the same control the start-thread composer renders
  // in its leading slot, so the pre-thread and live composers cannot drift.
  // Selecting another agent switches to THAT agent's thread for the same id
  // (each agent maps to its own thread by design). Memoized because it feeds
  // the memoized command bar through leadingBarContent.
  const picker = useMemo(
    () => <AgentPicker agents={memberAgents} selectedAgentNodeId={selectedAgent} onSelectAgent={setRememberedAgent} />,
    [memberAgents, selectedAgent, setRememberedAgent],
  )

  if (thread === undefined) {
    return <CenteredSpinner className={className} />
  }
  if (thread) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <GroupChatThreadChat thread={thread} leadingBarContent={picker} />
      </div>
    )
  }
  return (
    <EmbedStartComposer
      chat={chat}
      id={id}
      agents={memberAgents}
      selectedAgentNodeId={selectedAgent}
      onSelectAgent={setRememberedAgent}
      loadError={threadError}
      onStarted={onThreadStarted}
      className={className}
    />
  )
}

// The pre-thread state: the kit's start-thread composer, whose own agent
// picker is this surface's picker until a thread exists. No title field —
// the thread is titled with `id`, fixed, so the slug (and the session key's
// tail) reads as the id this surface was configured with.
function EmbedStartComposer({
  chat,
  id,
  agents,
  selectedAgentNodeId,
  onSelectAgent,
  loadError,
  onStarted,
  className,
}: {
  chat: GroupChatDetailView
  id: string
  agents: Array<{ nodeId: string; name: string; avatarUrl: string | null }>
  selectedAgentNodeId: string | null
  onSelectAgent: (nodeId: string) => void
  loadError?: string
  onStarted: () => void
  className?: string
}) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(loadError)

  // The selection rides on the FIRST message too — it is a send like any
  // other, only routed through startThread. Read at submit time; the badge
  // above the composer is the same control the live composer shows beside
  // its context ring (there is no ring yet without a session).
  const selectionScope = useOptionalSelection()

  // The composer clears itself (onValueChange('')) BEFORE onSubmit fires --
  // the command bar's clear-on-send contract. `onSubmit` takes no text, so by
  // the time it runs `value` may already read '' -- this mirrors the group-chat
  // screen's own start composer, keeping the typed text to send and, on
  // failure, to put back.
  const [lastTyped, setLastTyped] = useState('')

  const submit = async () => {
    const text = lastTyped
    if (!selectedAgentNodeId || !text.trim()) {
      setError('Choose an agent and write a message.')
      return
    }
    setError(undefined)
    setSubmitting(true)
    try {
      const firstMessage =
        selectionScope?.selection && selectionScope.passEnabled
          ? wrapUserSelection(text.trim(), selectionScope.selection.content)
          : text.trim()
      const result = await startGroupChatThread({
        data: { groupChatId: chat.id, agentNodeId: selectedAgentNodeId, firstMessage, title: id },
      })
      if (!result.ok) {
        setValue(text)
        setError(groupChatAccessMessageForCode(result.code))
        return
      }
      onStarted()
    } catch (e) {
      setValue(text)
      setError(failureMessage(e, 'The thread could not be started.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col justify-end', className)}>
      {/* The composer hugs its content and the slack sits above it. The kit's
          StartThreadComposer root carries `flex-1` -- it fills the footer row
          on the group-chat screen -- so as a flex child here it stretched to
          full height and its own content sat at the TOP of that box, leaving
          justify-end no free space to push against. `flex-none` puts the hug
          back, and the wrapper stays shrink-0 so the slack lands above it. */}
      <div className='flex shrink-0 flex-col gap-1 p-2'>
        <SelectionBadge />
        <StartThreadComposer
          className='flex-none'
          agents={agents}
          selectedAgentNodeId={selectedAgentNodeId}
          onSelectAgent={onSelectAgent}
          value={value}
          onValueChange={(next) => {
            if (next !== '') {
              setLastTyped(next)
            }
            setValue(next)
            if (error) {
              setError(undefined)
            }
          }}
          onSubmit={() => void submit()}
          submitting={submitting}
          error={error}
          onDismissError={() => setError(undefined)}
          placeholder={selectedAgentNodeId ? undefined : 'Choose an agent to start'}
        />
      </div>
    </div>
  )
}

// ── The create flow, when no chat carries this slug ──────────────────────

function CreateChatEmptyState({
  space,
  title,
  className,
  onCreated,
}: {
  space: string
  title?: string
  className?: string
  onCreated: () => void
}) {
  const name = title ?? space
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('flex h-full min-h-0 flex-col justify-center', className)}>
      <Empty className='py-8'>
        <EmptyHeader>
          <EmptyTitle>This chat does not exist</EmptyTitle>
          <EmptyDescription>
            No group chat named “{name}” was found. Create it and pick who takes part.
          </EmptyDescription>
        </EmptyHeader>
        <Button size='sm' onClick={() => setOpen(true)}>
          Create “{name}”
        </Button>
      </Empty>
      {open ? <CreateChatDialog space={space} name={name} onOpenChange={setOpen} onCreated={onCreated} /> : null}
    </div>
  )
}

// The creation dialog: the chat's name is fixed to `space` — the slug is
// derived from the name and has to come out as the slug this surface
// addresses, so there is nothing to type — and the picker collects members
// locally before anything exists to add them to. On Create the chat is
// created (the caller becomes its first member automatically) and the picked
// principals are added through the same membership path the members dialog
// uses.
function CreateChatDialog({
  space,
  name,
  onOpenChange,
  onCreated,
}: {
  space: string
  name: string
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [directory, setDirectory] = useState<DirectoryUser[]>()
  const [agents, setAgents] = useState<AgentNodeRef[]>()
  const [picked, setPicked] = useState<Array<{ kind: 'user' | 'agent'; id: string }>>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    Promise.all([listDirectoryUsersForPicker(), listAgentNodes()])
      .then(([users, nodes]) => {
        if (!cancelled) {
          setDirectory(users)
          setAgents(nodes)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(failureMessage(e, 'The member list could not be loaded.'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const candidates = useMemo<MemberCandidate[]>(
    () => [
      ...(directory ?? []).map((u) => ({ kind: 'user' as const, id: u.id, name: u.name, avatarUrl: u.avatarUrl })),
      ...(agents ?? []).map((a) => ({
        kind: 'agent' as const,
        id: a.nodeId,
        name: a.name,
        avatarUrl: a.avatar ?? null,
      })),
    ],
    [directory, agents],
  )
  const create = async () => {
    setError(undefined)
    setCreating(true)
    try {
      // The ADDRESS is passed explicitly rather than left to fall out of the
      // name. This surface finds the chat again by `space`, so the two must be
      // the same string, and they are only the same by luck when the name is
      // slugified: two spaces both called "Docs" hold `docs` and `docs-2`, and
      // the second would mint `docs`, be refused as taken, and never have a
      // chat of its own. Passing both keeps the name readable and the address
      // correct.
      const result = await createMyGroupChat({ data: { name, slug: space } })
      if (!result.ok) {
        setError(groupChatAccessMessageForCode(result.code))
        return
      }
      for (const principal of picked) {
        const added = await addGroupChatMember({
          data: {
            groupChatId: result.chat.id,
            principal:
              principal.kind === 'user'
                ? { kind: 'user', userId: principal.id }
                : { kind: 'agent', agentNodeId: principal.id },
          },
        })
        if (!added.ok) {
          // The chat exists and the caller is in it — surface the member that
          // failed rather than pretending the whole creation did. The rest is
          // manageable from the members dialog in the group-chats UI.
          setError(groupChatAccessMessageForCode(added.code))
          onCreated()
          return
        }
      }
      onOpenChange(false)
      onCreated()
    } catch (e) {
      setError(failureMessage(e, 'The group chat could not be created.'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          {/* The NAME, not the address. A person is being asked to create
              "My Space", not "my-space". */}
          <DialogTitle>Create “{name}”</DialogTitle>
        </DialogHeader>
        <AddMemberPicker
          candidates={candidates}
          members={picked}
          onAdd={(principal) => setPicked((prev) => [...prev, { kind: principal.kind, id: principal.id }])}
          adding={creating}
          onRemove={(principal) =>
            setPicked((prev) => prev.filter((p) => !(p.kind === principal.kind && p.id === principal.id)))
          }
          removing={creating}
          error={error}
        />
        <MemberSummary count={picked.length} />
        <div className='flex justify-end gap-2'>
          <Button variant='outline' onClick={() => onOpenChange(false)} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MemberSummary({ count }: { count: number }): ReactNode {
  if (count === 0) {
    return (
      <p className='text-sm text-muted-foreground'>
        You will be a member automatically. Add the agents this chat should reach — a chat without agents cannot hold a
        thread.
      </p>
    )
  }
  return (
    <p className='text-sm text-muted-foreground'>
      {count === 1 ? '1 member picked' : `${count} members picked`}, plus you.
    </p>
  )
}
