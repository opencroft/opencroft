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
//   - not a member, and
//     the slug names a
//     space               → an empty state offering to JOIN, which adds them.
//                           Being in the space is what entitles a person to
//                           that space's chat, so there is nobody to ask.
//                           This replaces the collapsed refusal that used to
//                           stand here and gave a live button in the product
//                           nothing to do.
//   - not a member, and
//     the slug names no
//     space               → the collapsed refusal the thread route shows,
//                           unchanged. Whether Join belongs on an arbitrary
//                           chat is a separate, unanswered question; the
//                           server decides which case this is.
//   - no thread yet, or
//     the chat's home
//     was chosen          → the group chat's OWN screen -- topic, members,
//                           pins, the thread list and the start composer --
//                           the same one the group-chats route draws, loaded
//                           here. A thread chosen or started there opens in
//                           this panel; the host's Back leads back to it.
//                           This is the second of the two windows the
//                           group-chats section has always had, and the
//                           embedded surface used to offer a bare "New chat"
//                           composer in its place.
//   - a new id was asked
//     for explicitly      → the SAME start composer the group-chat screen's
//                           footer renders, titled with that id (fixed, so the
//                           slug and the session key's tail read as the id);
//                           the first send creates the thread.
//   - thread exists       → the shared assembly reattaches to it. No agent
//                           picker: the thread names its agent, and switching
//                           conversations is the chat's home screen's job.

import { MessageCirclePlus, UserPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CommandBarFrame } from 'ui/agent-chat/command-bar-frame'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/empty'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import type { ThreadWork } from 'ui/group-chat/thread-work-control'
import { LogoLoader } from 'ui/logo-loader'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import {
  type GroupChatDetailData,
  type GroupChatDetailHeader,
  GroupChatDetailScreen,
} from '@/app/_authed/(group-chats)/_components/group-chat-detail-screen'
import { GroupChatRefusal } from '@/app/_authed/(group-chats)/_components/group-chat-error'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
import { GroupChatThreadChat } from '@/app/_authed/(group-chats)/_components/group-chat-thread-chat'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { GroupChatRefreshProvider } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
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
  getGroupChatThreadLayout,
  getGroupChatThreadView,
  getMyGroupChatView,
  joinSpaceGroupChat,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'
import { listAgentNodes } from '@/app/_authed/(space)/_server/agents'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'
import { cn } from '@/lib/utils'

/**
 * Which conversation an embedded surface shows, when not its default thread:
 * an EXISTING thread by its id (any thread of the chat, whatever agent it
 * belongs to), a NEW one — an id no thread carries yet, so the surface shows
 * the start composer and the first send creates it — or the chat's HOME: the
 * group chat's own screen, where the threads are listed and started. Produced
 * by the surface itself (a row chosen on the home screen), by the host's Back
 * (home again) and by the ChatSelector, for hosts that still mount one.
 */
export type EmbeddedChatSelection = { threadId: string } | { newId: string } | { home: true }

/**
 * What the open thread's header would say, for a host that draws that header
 * itself. The dock window has a header per arrangement already, and a second
 * one inside the surface read as two -- so the surface reports the facts and
 * the host puts them in the header it owns. Null while no thread is open.
 *
 * Identity-stable per change of its parts (the surface memoizes it), so a host
 * may hold it in state or hang an effect off it without a render loop.
 */
export interface EmbeddedThreadContext {
  agent: { name: string; avatarUrl?: string | null }
  /** The chat's display NAME -- a breadcrumb names a place, and the slug this
   *  surface is addressed by is not what a place is called. */
  groupChatName: string
  threadTitle: string
  status: SessionStatus
  work: ThreadWork
}

export interface EmbeddedAgentChatProps {
  /** The group chat's slug — the first segment of every thread session key. */
  space: string
  /** The DEFAULT thread slug this surface owns, one per member agent. */
  id: string
  /** Override the shown conversation — see EmbeddedChatSelection. Unset = the default thread. */
  thread?: EmbeddedChatSelection | null
  /**
   * The surface asks to show something else: a thread chosen or started on
   * the chat's home screen. A host that owns `thread` (the dock does) applies
   * it there; a host that passes none lets the surface keep the choice itself.
   */
  onSelectionChange?: (selection: EmbeddedChatSelection) => void
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
  /**
   * Reports the open thread's header facts -- see EmbeddedThreadContext -- and
   * null whenever there is no open thread (loading, the start composer, a
   * refusal, or this surface going away). Same contract as `onChatAvailable`:
   * a notification for a host that owns the chrome, never a render slot.
   */
  onThreadContext?: (context: EmbeddedThreadContext | null) => void
  /**
   * Reports the chat home screen's header parts -- its title area and its
   * controls -- while that screen is open, and null otherwise. A host that
   * passes this draws them in its own header, and the home screen draws none:
   * the same arrangement `onThreadContext` gives an open thread, so the window
   * has one header whichever screen is up.
   */
  onHomeHeader?: (header: GroupChatDetailHeader | null) => void
  className?: string
}

type EmbedPhase =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'joinable' }
  | { phase: 'refused'; view: Extract<GroupChatEmbedView, { state: 'refused' }> }
  | { phase: 'ready'; chat: GroupChatDetailView }
  | { phase: 'error'; message: string }

export function EmbeddedAgentChat({
  space,
  id,
  thread,
  onSelectionChange,
  title,
  onChatAvailable,
  onThreadContext,
  onHomeHeader,
  className,
}: EmbeddedAgentChatProps) {
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
        } else if (view.state === 'joinable') {
          setState({ phase: 'joinable' })
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
    case 'joinable':
      return <JoinChatEmptyState space={space} className={className} onJoined={reload} />
    case 'missing':
      return <CreateChatEmptyState space={space} title={title} className={className} onCreated={reload} />
    case 'ready':
      return (
        <EmbeddedThread
          chat={state.chat}
          id={id}
          title={title}
          selection={thread ?? undefined}
          onSelectionChange={onSelectionChange}
          onThreadContext={onThreadContext}
          onHomeHeader={onHomeHeader}
          className={className}
        />
      )
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
  title,
  selection: hostSelection,
  onSelectionChange,
  onThreadContext,
  onHomeHeader,
  className,
}: {
  chat: GroupChatDetailView
  id: string
  /** The host's name for the chat, when it has one -- see EmbeddedAgentChatProps. */
  title?: string
  selection?: EmbeddedChatSelection
  onSelectionChange?: (selection: EmbeddedChatSelection) => void
  onThreadContext?: (context: EmbeddedThreadContext | null) => void
  onHomeHeader?: (header: GroupChatDetailHeader | null) => void
  className?: string
}) {
  // A choice made on the home screen goes to the host when it takes them --
  // the dock holds the selection and remembers it -- and is kept here
  // otherwise, so a host that only ever passed `thread` still gets a working
  // home screen.
  const [ownSelection, setOwnSelection] = useState<EmbeddedChatSelection | undefined>(undefined)
  const selection = onSelectionChange ? hostSelection : (ownSelection ?? hostSelection)
  const choose = onSelectionChange ?? setOwnSelection
  const home = selection !== undefined && 'home' in selection
  // An explicit thread is shown as-is, whatever agent it belongs to; a new id
  // replaces the default one on the ordinary find-or-start path.
  const explicitThreadId = selection && 'threadId' in selection ? selection.threadId : null
  const newId = selection && 'newId' in selection ? selection.newId : null
  const effectiveId = newId ?? id
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
    // The home screen names no thread; nothing to resolve.
    if (home) {
      setThread(null)
      return
    }
    // A selected thread is loaded by its own id — no (agent, slug) mapping,
    // because the home screen offers every thread of the chat, not just the
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
  }, [chat.id, selectedAgent, effectiveId, explicitThreadId, home, threadTick])

  const onThreadStarted = useCallback(() => setThreadTick((tick) => tick + 1), [])
  const openThread = useCallback((threadId: string) => choose({ threadId }), [choose])

  // The same shared session-activity poll (and the same derivation) the
  // group-chat screens read — one status vocabulary, one source. Enabled only
  // once there is a thread whose session the status could be about.
  const { pendingKeys, activeKeys, backgroundKeys, aliveKeys } = useSessionActivityKeys(Boolean(thread))
  const status = thread
    ? deriveSessionStatus(thread.sessionKey, {
        pending: pendingKeys,
        active: activeKeys,
        background: backgroundKeys,
        alive: aliveKeys,
      })
    : undefined

  // The open thread's delegated work, as the shared assembly reports it. Null
  // until the assembly has folded once; the header facts below wait for it so
  // a host never sees a context with nothing to count.
  const [work, setWork] = useState<ThreadWork | null>(null)
  // The header facts the host draws, memoized so a host holding them in state
  // is told once per real change. The chat's NAME leads the breadcrumb: the
  // host's own name for it where it passed one (the dock passes the space's
  // name), the chat's stored name otherwise -- never the slug this surface is
  // addressed by.
  const context = useMemo<EmbeddedThreadContext | null>(
    () =>
      thread && status && work
        ? {
            agent: thread.agent,
            groupChatName: title ?? chat.name,
            threadTitle: thread.title || id,
            status,
            work,
          }
        : null,
    [thread, status, work, title, chat.name, id],
  )
  // Reported through a ref so an inline callback never re-arms this, and
  // cleared on the way out: a host that heard about a thread must hear that it
  // is gone, or its header keeps naming a conversation nobody is looking at.
  const onThreadContextRef = useRef(onThreadContext)
  onThreadContextRef.current = onThreadContext
  useEffect(() => {
    onThreadContextRef.current?.(context)
    return () => onThreadContextRef.current?.(null)
  }, [context])

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
        {/* The default, chrome-less frame. Where the reader is and who is
            working are the HOST's header's to say -- the dock window draws
            them from `onThreadContext` -- because a header inside a window
            that already has one read as two headers. */}
        <GroupChatThreadChat thread={thread} onWorkChange={setWork} />
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
  // No thread to show: the chat's home screen, unless a specific new id was
  // asked for. The default thread not existing yet lands here too -- the
  // reader picks a thread or starts one from the home screen's composer,
  // which is what "New chat" used to be a bare stand-in for.
  if (home || !newId) {
    return <EmbeddedChatHome chat={chat} onOpenThread={openThread} onHeader={onHomeHeader} className={className} />
  }
  // The explicit-new-id state: the same start composer the group-chat
  // screen's footer renders, in the same CommandBarFrame every chat footer
  // sits in — so this state looks like the composer the thread will have, not
  // like a bare form. Configured for this surface: the thread is titled with
  // the id (fixed, so the slug and the session key's tail read as the id),
  // and the agent selection is the SAME state the live thread's picker
  // switches, so the two controls cannot disagree.
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
            <EmptyDescription>
              Send the first message to start the conversation — or start it empty and set the agent up first.
            </EmptyDescription>
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

// ── The chat's home screen inside the panel ──────────────────────────────

/**
 * The group chat's own screen -- topic, members, pins, threads, the start
 * composer -- drawn inside the panel. The route loads the same data in a
 * loader; here it is loaded on mount and reloaded through the group-chat
 * refresh context, which is what the pins panel, the members dialog and the
 * rename / delete dialogs call after a write. Without the provider they would
 * invalidate the host page's route, which knows nothing about this chat.
 */
function EmbeddedChatHome({
  chat,
  onOpenThread,
  onHeader,
  className,
}: {
  chat: GroupChatDetailView
  onOpenThread: (threadId: string) => void
  onHeader?: (header: GroupChatDetailHeader | null) => void
  className?: string
}) {
  const [data, setData] = useState<GroupChatDetailData | null>(null)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    const [fresh, threads, directory, agents, pins, layout] = await Promise.all([
      getMyGroupChatView({ data: chat.id }),
      listGroupChatThreadsView({ data: chat.id }),
      listDirectoryUsersForPicker(),
      listAgentNodes(),
      listMyGroupChatPins({ data: chat.id }),
      getGroupChatThreadLayout({ data: chat.id }),
    ])
    setData({ chat: fresh, threads, directory, agents, pins, layout })
  }, [chat.id])
  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(undefined)
    load().catch((e) => {
      if (!cancelled) {
        setError(failureMessage(e, 'This chat could not be loaded.'))
      }
    })
    return () => {
      cancelled = true
    }
  }, [load])

  if (error) {
    return (
      <Empty className={cn('h-full', className)}>
        <EmptyHeader>
          <EmptyTitle>Something went wrong</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!data) {
    return <CenteredSpinner className={className} />
  }
  return (
    <GroupChatRefreshProvider refresh={load}>
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        <GroupChatDetailScreen
          className='min-h-0 flex-1'
          groupChatId={chat.id}
          chat={data.chat}
          threads={data.threads}
          directory={data.directory}
          agents={data.agents}
          pins={data.pins}
          layout={data.layout}
          onHeader={onHeader}
          onOpenThread={onOpenThread}
          onThreadStarted={onOpenThread}
        />
      </div>
    </GroupChatRefreshProvider>
  )
}

// ── The join flow, when the chat is there and the reader is not in it ────

/**
 * One control, and it adds them. Nobody is asked and nothing is requested:
 * the entitlement is already established by being in the space, so a Join
 * that produced a pending state would be inventing an approval step the
 * product does not have.
 *
 * The copy keeps the create flow's discipline — no slug, no chat name, no
 * "group chat". The reader opened the chat of THIS space; which chat it is
 * goes without saying. It also says nothing about WHY they are not in it,
 * because nothing here knows: not being added and having been removed look
 * the same from here, and a sentence that picked one would be wrong half the
 * time.
 */
function JoinChatEmptyState({
  space,
  className,
  onJoined,
}: {
  space: string
  className?: string
  onJoined: () => void
}) {
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string>()
  const join = async () => {
    setError(undefined)
    setJoining(true)
    try {
      const result = await joinSpaceGroupChat({ data: space })
      if (!result.ok) {
        // The server disagrees that this chat is joinable — the same question
        // the read answered, asked again at the moment it mattered, and it is
        // the answer that counts. Shown rather than reloaded into: a reload
        // would replace the sentence with the collapsed refusal screen, which
        // says less about what just happened.
        setError(groupChatAccessMessageForCode(result.code))
        return
      }
      onJoined()
    } catch (e) {
      setError(failureMessage(e, 'You could not be added to this chat.'))
    } finally {
      setJoining(false)
    }
  }
  return (
    <div className={cn('flex h-full min-h-0 flex-col justify-center', className)}>
      <Empty className='py-8'>
        <EmptyHeader>
          <EmptyMedia>
            <UserPlus className='size-6 text-muted-foreground' />
          </EmptyMedia>
          <EmptyTitle>Join this chat</EmptyTitle>
          <EmptyDescription>You are not in this chat yet.</EmptyDescription>
        </EmptyHeader>
        <Button size='sm' onClick={() => void join()} disabled={joining}>
          {joining ? 'Joining…' : 'Join'}
        </Button>
        {error ? <p className='text-sm text-destructive'>{error}</p> : null}
      </Empty>
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
