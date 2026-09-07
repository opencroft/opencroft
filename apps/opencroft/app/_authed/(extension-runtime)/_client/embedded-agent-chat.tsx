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
//   - no thread yet       → the SAME start composer the group-chat screen's
//                           footer renders (its agent picker doubles as this
//                           surface's picker); the first send creates the
//                           thread through the membership-checked startThread
//                           path, titled with `id` so the slug — and so the
//                           session key's tail — reads as the id.
//   - thread exists       → the shared assembly reattaches to it. No agent
//                           picker: the thread names its agent, and switching
//                           conversations is the ChatSelector's job.

import { MessageCirclePlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CommandBarFrame } from 'ui/agent-chat/command-bar-frame'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/empty'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { LogoLoader } from 'ui/logo-loader'

import { GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
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
  getGroupChatThreadView,
  listDirectoryUsersForPicker,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'
import { listAgentNodes } from '@/app/_authed/(space)/_server/agents'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'
import { cn } from '@/lib/utils'

/**
 * Which conversation an embedded surface shows, when not its default thread:
 * an EXISTING thread by its id (any thread of the chat, whatever agent it
 * belongs to), or a NEW one — an id no thread carries yet, so the surface
 * shows the start composer and the first send creates it. Produced by the
 * ChatSelector beside the surface's dock controls.
 */
export type EmbeddedChatSelection = { threadId: string } | { newId: string }

export interface EmbeddedAgentChatProps {
  /** The group chat's slug — the first segment of every thread session key. */
  space: string
  /** The DEFAULT thread slug this surface owns, one per member agent. */
  id: string
  /** Override the shown conversation — see EmbeddedChatSelection. Unset = the default thread. */
  thread?: EmbeddedChatSelection | null
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
  /**
   * Reports whether the chat RESOLVED: true only when it exists and the caller
   * can see it, false while loading and when it is missing, refused or failed.
   * A host uses it to hide controls that only mean something against an
   * existing chat — the ChatSelector beside the dock buttons.
   */
  onChatAvailable?: (available: boolean) => void
  className?: string
}

type EmbedPhase =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'refused'; view: Extract<GroupChatEmbedView, { state: 'refused' }> }
  | { phase: 'ready'; chat: GroupChatDetailView }
  | { phase: 'error'; message: string }

export function EmbeddedAgentChat({ space, id, thread, title, onChatAvailable, className }: EmbeddedAgentChatProps) {
  const [state, setState] = useState<EmbedPhase>({ phase: 'loading' })
  // Bumped to reload after the create flow finishes — the cheapest way to go
  // from `missing` to `ready` through the same single load path.
  const [loadTick, setLoadTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies(loadTick): not read in the body — it exists to re-run this load after the create flow finishes
  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    onChatAvailable?.(false)
    getGroupChatEmbedView({ data: space })
      .then((view) => {
        if (cancelled) {
          return
        }
        onChatAvailable?.(view.state === 'ok')
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
  }, [space, loadTick, onChatAvailable])

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
      return <EmbeddedThread chat={state.chat} id={id} selection={thread ?? undefined} className={className} />
  }
}

/**
 * A stand-in the exact height of the command bar (its `min-h-8` textarea plus
 * the `h-7` action row and the gap between them), inside the same frame and
 * inset the real composer arrives in. Loading states render it so the footer's
 * space is spent from the first frame — without it the loader centres on the
 * full panel and JUMPS UP when the composer appears beneath it, which the
 * group-chat screen (whose route loads everything before rendering) never
 * shows.
 */
function ComposerSkeleton() {
  return (
    <div className='shrink-0 p-2'>
      <CommandBarFrame>
        <div aria-hidden className='h-16 w-full' />
      </CommandBarFrame>
    </div>
  )
}

function CenteredSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className='flex min-h-24 flex-1 items-center justify-center'>
        {/* Same size and color as the open thread's own loader (agent-chat),
            which follows this one on the same panel — two different loaders
            in sequence read as a glitch. */}
        <LogoLoader size={40} className='text-foreground' />
      </div>
      <ComposerSkeleton />
    </div>
  )
}

// ── The thread surface, once the chat resolved ───────────────────────────

function EmbeddedThread({
  chat,
  id,
  selection,
  className,
}: {
  chat: GroupChatDetailView
  id: string
  selection?: EmbeddedChatSelection
  className?: string
}) {
  // An explicit thread is shown as-is, whatever agent it belongs to; a new id
  // replaces the default one on the ordinary find-or-start path.
  const explicitThreadId = selection && 'threadId' in selection ? selection.threadId : null
  const effectiveId = selection && 'newId' in selection ? selection.newId : id
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
    let cancelled = false
    setThread(undefined)
    setThreadError(undefined)
    // A selected thread is loaded by its own id — no (agent, slug) mapping,
    // because the selector offers every thread of the chat, not just the
    // picked agent's.
    if (explicitThreadId) {
      getGroupChatThreadView({ data: explicitThreadId })
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
    }
    if (!selectedAgent) {
      setThread(null)
      return
    }
    findGroupChatEmbedThread({ data: { groupChatId: chat.id, agentNodeId: selectedAgent, id: effectiveId } })
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
  }, [chat.id, selectedAgent, effectiveId, explicitThreadId, threadTick])

  const onThreadStarted = useCallback(() => setThreadTick((tick) => tick + 1), [])

  if (thread === undefined) {
    return <CenteredSpinner className={className} />
  }
  if (thread) {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        {/* No agent picker on an OPEN thread — a thread already names its
            agent, and switching conversations is the ChatSelector's job. The
            picker's one remaining home is the start composer below, where an
            agent genuinely has to be chosen. */}
        <GroupChatThreadChat thread={thread} />
      </div>
    )
  }
  if (explicitThreadId) {
    // A selected thread that failed to load must not fall through to the
    // start composer — that would offer to start the DEFAULT thread under a
    // heading the reader did not choose.
    return (
      <Empty className={cn('h-full', className)}>
        <EmptyHeader>
          <EmptyTitle>This thread is not available</EmptyTitle>
          <EmptyDescription>{threadError ?? 'It may have been deleted.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  // The pre-thread state: the same start composer the group-chat screen's
  // footer renders, in the same CommandBarFrame every chat footer sits in —
  // so this state looks like the composer the thread will have, not like a
  // bare form. Configured for this surface: the thread is titled with the id
  // (fixed, so the slug and the session key's tail read as the id), and the
  // agent selection is the SAME state the live thread's picker switches, so
  // the two controls cannot disagree.
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* The slack above the composer carries the same empty-state family the
          create flow and the "No messages yet" placeholder wear — without it
          this window is a bare panel with a lone composer at the bottom. */}
      <div className='flex min-h-0 flex-1 flex-col justify-center'>
        <Empty className='py-8'>
          <EmptyHeader>
            <EmptyMedia>
              <MessageCirclePlus className='size-6 text-muted-foreground' />
            </EmptyMedia>
            <EmptyTitle>New chat</EmptyTitle>
            <EmptyDescription>Send the first message to start the conversation.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
      {/* shrink-0 so the frame hugs its content and the slack lands above it;
          the selection badge renders INSIDE the frame, by the composer itself,
          in the same place the live composer's attachments slot puts it. */}
      <div className='shrink-0 p-2'>
        <CommandBarFrame>
          <GroupChatStartThreadComposer
            groupChatId={chat.id}
            members={chat.members}
            fixedTitle={effectiveId}
            selectedAgentNodeId={selectedAgent}
            onSelectAgent={setRememberedAgent}
            loadError={threadError}
            placeholder={selectedAgent ? undefined : 'Choose an agent to start'}
            onThreadStarted={onThreadStarted}
          />
        </CommandBarFrame>
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
      {/* No internals in the copy — no "group chat", no slug, no name in
          quotes. The reader opened the chat of THIS space; whose chat it is
          goes without saying, and who takes part is the next step's dialog,
          not this sentence. The bare muted mark matches the reworked
          "No messages yet" placeholder — same family, no tile. */}
      <Empty className='py-8'>
        <EmptyHeader>
          <EmptyMedia>
            <MessageCirclePlus className='size-6 text-muted-foreground' />
          </EmptyMedia>
          <EmptyTitle>Start a chat</EmptyTitle>
          <EmptyDescription>This space has no chat yet.</EmptyDescription>
        </EmptyHeader>
        <Button size='sm' onClick={() => setOpen(true)}>
          Create chat
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
