'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { buildBlocks, type ChatBlock, foldEvents } from 'agent-client/fold'
import type { AgentProfile } from 'agent-client/profiles'
import type { AgentSelection, AvailableCommand, ChatEvent, QueuedPrompt, SessionMode } from 'agent-client/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { buildKitBlocks } from './kit-blocks'
import { canStartSelection, EMPTY_SELECTION } from './preset-form'
import {
  cancelAgentTurn,
  deleteAgentProfile,
  deleteAgentSession,
  editAgentTurn,
  forkAgentSession,
  getAgentConfig,
  getAgentRoles,
  listAgentProfiles,
  listAgentSessions,
  listOpenAiModels,
  removeQueuedPrompt,
  respondAsk,
  respondPermission,
  saveAgentProfile,
  sendAgentPrompt,
  setActiveProfile,
  setAgentConfigOption,
  setAgentMode,
  startAgentSession,
} from './server/actions'
import type { AgentChatEdit, AgentChatSession, PendingAsk, PendingPermission } from './session'
import { toEditableParts } from './user-parts'

export interface UseAgentSessionOptions {
  // The SSE endpoint that streams a session's events (its `?sessionId=` is
  // appended). The host route should delegate to `agentEventsResponse`.
  eventsUrl?: string
}

export interface AgentUsage {
  used: number
  size?: number
}

// Drives a single live agent chat: profiles + selection editing, session
// lifecycle, the SSE event stream (folded to blocks), turn control, and the
// permission/ask responders. The <AgentChat> composite is a thin view over this.
export function useAgentSession({ eventsUrl = '/api/acp/events' }: UseAgentSessionOptions = {}) {
  const [selection, setSelection] = useState<AgentSelection>(EMPTY_SELECTION)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [name, setName] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Whether this session's agent can fork its history, as the engine resolved
  // it at session start (native store, or an advertised `session/fork`).
  const [canFork, setCanFork] = useState(false)
  // True until the initial profiles + session load resolves — lets a host
  // show a distinct "loading" state instead of momentarily flashing "no
  // messages yet" before anything's been fetched.
  const [loading, setLoading] = useState(true)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [input, setInput] = useState('')
  const [turnActive, setTurnActive] = useState(false)
  const [modes, setModes] = useState<SessionMode[]>([])
  const [currentMode, setCurrentMode] = useState('')
  // The session's dynamically advertised config options (model/effort/mode/…,
  // ACP agents only) — see agent-client's config_options event. Empty for
  // adapters that don't advertise any.
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([])
  // Commands the agent advertised (available_commands event) — feeds the
  // composer's slash autocomplete. Empty for adapters that advertise none.
  const [commands, setCommands] = useState<AvailableCommand[]>([])
  const [queue, setQueue] = useState<QueuedPrompt[]>([])
  const [usage, setUsage] = useState<AgentUsage | null>(null)
  const [starting, setStarting] = useState(false)
  const [loadedModels, setLoadedModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([])
  const [roleIds, setRoleIds] = useState<string[]>([])

  // Load a profile into the editor (active id + name + selection + roles).
  const applyProfile = useCallback((profile: AgentProfile) => {
    setActiveId(profile.id)
    setName(profile.name)
    setSelection(profile.selection)
    setRoleIds(profile.roleIds ?? [])
  }, [])

  // The roles a profile can be assigned (for the preset form's selector).
  useEffect(() => {
    getAgentRoles()
      .then((list) => setRoles(list.map((role) => ({ id: role.id, name: role.name }))))
      .catch(() => setRoles([]))
  }, [])

  // Initial load: profiles (seed one from any legacy config if none) + session.
  useEffect(() => {
    Promise.all([listAgentProfiles(), getAgentConfig()]).then(([store, saved]) => {
      if (store.profiles.length === 0) {
        const seed: AgentProfile = {
          id: crypto.randomUUID(),
          name: 'Default',
          selection: saved ?? { ...EMPTY_SELECTION },
        }
        setProfiles([seed])
        applyProfile(seed)
        return
      }
      setProfiles(store.profiles)
      applyProfile(store.profiles.find((entry) => entry.id === store.activeProfileId) ?? store.profiles[0])
    })
    listAgentSessions()
      .then((list) => list[0] && setSessionId(list[0].id))
      .finally(() => setLoading(false))
  }, [applyProfile])

  // Stream the active session's events. `subscribe` replays history on connect,
  // so we reset on each (re)connection to avoid duplicating the replayed events.
  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      return
    }
    const source = new EventSource(`${eventsUrl}?sessionId=${encodeURIComponent(sessionId)}`)
    source.onopen = () => {
      setEvents([])
      setUsage(null)
    }
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ChatEvent
      setEvents((prev) => [...prev, event])
      switch (event.kind) {
        case 'modes':
          setModes(event.available)
          setCurrentMode(event.current)
          break
        case 'mode_changed':
          setCurrentMode(event.current)
          break
        case 'config_options':
          setConfigOptions(event.options)
          break
        case 'available_commands':
          setCommands(event.commands)
          break
        case 'usage':
          setUsage({ used: event.used, size: event.size })
          break
        case 'queue':
          setQueue(event.items)
          break
        case 'user':
          setTurnActive(true)
          break
        case 'turn_end':
        case 'error':
          setTurnActive(false)
          break
      }
    }
    return () => source.close()
  }, [sessionId, eventsUrl])

  const messages = useMemo(() => foldEvents(events), [events])
  const blocks: ChatBlock[] = useMemo(() => buildBlocks(messages), [messages])
  // The same transcript in the vocabulary the installed conversation renders.
  const kitBlocks = useMemo(() => buildKitBlocks(messages), [messages])

  // Unresolved approvals, read off the same folded transcript rather than
  // tracked separately: the fold already flips `resolved` when the resolution
  // event arrives, so a second source of truth could only drift from it. A
  // host renders these with <Approvals> — a request with nowhere to be
  // answered blocks its turn until the turn is killed.
  const pending = useMemo(() => {
    const permissions: PendingPermission[] = []
    const asks: PendingAsk[] = []
    for (const message of messages) {
      if (message.kind === 'permission' && !message.resolved) {
        permissions.push({ requestId: message.requestId, title: message.title, options: message.options })
      } else if (message.kind === 'ask' && !message.resolved) {
        asks.push({
          requestId: message.requestId,
          message: message.message,
          ...(message.form ? { form: message.form } : {}),
          ...(message.url ? { url: message.url } : {}),
        })
      }
    }
    return { permissions, asks }
  }, [messages])

  const isCustomEndpoint = selection.providerId === 'openai-compatible'
  const canStart = canStartSelection(selection)

  const loadModels = useCallback(async () => {
    if (!selection.baseUrl) return
    setLoadingModels(true)
    try {
      setLoadedModels(await listOpenAiModels(selection.baseUrl, selection.apiKey || undefined))
    } catch (error) {
      toast.error('Failed to load models', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setLoadingModels(false)
    }
  }, [selection.baseUrl, selection.apiKey])

  // Auto-load models from the endpoint once a custom base URL is present.
  useEffect(() => {
    if (isCustomEndpoint && selection.baseUrl?.startsWith('http')) {
      void loadModels()
    } else if (!isCustomEndpoint) {
      setLoadedModels([])
    }
  }, [isCustomEndpoint, selection.baseUrl, loadModels])

  const updateSelection = useCallback((patch: Partial<AgentSelection>) => {
    setSelection((prev) => ({ ...prev, ...patch }))
  }, [])

  const saveProfile = useCallback(async () => {
    const profile: AgentProfile = {
      id: activeId,
      name: name.trim() || 'Untitled',
      selection,
      roleIds,
    }
    const store = await saveAgentProfile(profile, true)
    setProfiles(store.profiles)
    toast.success('Profile saved')
  }, [activeId, name, selection, roleIds])

  const switchProfile = useCallback(
    (id: string) => {
      const profile = profiles.find((entry) => entry.id === id)
      if (profile) {
        applyProfile(profile)
        void setActiveProfile(id)
      }
    },
    [profiles, applyProfile],
  )

  const newProfile = useCallback(async () => {
    const profile: AgentProfile = {
      id: crypto.randomUUID(),
      name: 'New profile',
      selection: { ...EMPTY_SELECTION },
    }
    applyProfile(profile)
    const store = await saveAgentProfile(profile, true)
    setProfiles(store.profiles)
  }, [applyProfile])

  const deleteProfile = useCallback(async () => {
    if (!activeId) return
    const store = await deleteAgentProfile(activeId)
    if (store.profiles.length === 0) {
      await newProfile()
      return
    }
    setProfiles(store.profiles)
    applyProfile(store.profiles.find((entry) => entry.id === store.activeProfileId) ?? store.profiles[0])
  }, [activeId, newProfile, applyProfile])

  const resetSessionState = useCallback(() => {
    setEvents([])
    setModes([])
    setCurrentMode('')
    setConfigOptions([])
    setUsage(null)
    setTurnActive(false)
    setQueue([])
    setCanFork(false)
  }, [])

  const start = useCallback(async () => {
    if (!canStart) return
    setStarting(true)
    try {
      const meta = await startAgentSession(selection)
      resetSessionState()
      setSessionId(meta.id)
      setCanFork(meta.canFork ?? false)
    } catch (error) {
      toast.error('Failed to start session', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStarting(false)
    }
  }, [canStart, selection, resetSessionState])

  const clear = useCallback(async () => {
    if (!sessionId) return
    await deleteAgentSession(sessionId)
    setSessionId(null)
    resetSessionState()
  }, [sessionId, resetSessionState])

  // Rewind the conversation to a user turn and continue from there. The branch
  // replays the truncated transcript — the engine forks the native harness's
  // own store, or the agent's own transcript when it advertised `session/fork`.
  const fork = useCallback(
    async (dropFromTurn: number) => {
      if (!sessionId) return
      try {
        const meta = await forkAgentSession(sessionId, dropFromTurn)
        if (meta) {
          // Switching the id reconnects the event stream, replaying the rewound
          // transcript of the fork.
          setTurnActive(false)
          setSessionId(meta.id)
        }
      } catch (error) {
        toast.error('Failed to fork session', {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [sessionId],
  )

  // ---- editing a delivered turn ----
  //
  // Opening stages nothing in the composer: a turn can carry several messages,
  // and putting the whole delivery in front of the reader means putting the
  // tags that separate them there too. The composer takes them one at a time
  // (see the command bar's own edit machinery), and the fork happens on commit,
  // beside the rebuild, so an abandoned edit branches nothing.
  const [edit, setEdit] = useState<AgentChatEdit | undefined>(undefined)

  // The RAW delivered turn is what gets decoded, found by the block id the
  // transcript handed back. Blocks carry the turn already rendered for display;
  // decoding that instead would let a host's own stripper change how many
  // messages the client thinks the turn has, and a commit would then write a
  // body into the wrong one.
  //
  // The id a block carries is a fold counter, not a position in the event log,
  // so it is turned into one here: which user turn this is among the folded
  // messages, then which event that turn is. Sound only because this hook holds
  // the whole stream -- `subscribe` replays from the first event and nothing
  // here drops any of it. A paginated transcript could not do this, and would
  // have to carry the event index on the message instead.
  const startEdit = useCallback(
    (blockId: string) => {
      const userMessages = messages.filter((message) => message.kind === 'user')
      const ordinal = userMessages.findIndex((message) => `u:${message.id}` === blockId)
      const message = userMessages[ordinal]
      const eventIndex = events.flatMap((event, index) => (event.kind === 'user' ? [index] : []))[ordinal]
      if (!message || eventIndex === undefined) {
        return
      }
      const parts = toEditableParts(message.text, (raw) => (raw.trim() ? raw : null))
      if (parts.length === 0) {
        return
      }
      setEdit({ eventIndex, parts })
    },
    [messages, events],
  )

  const cancelEdit = useCallback(() => setEdit(undefined), [])

  // Words only. Who sent each message and when is resolved server-side from the
  // delivered turn -- see editAgentTurn, and the same reasoning that keeps the
  // sender off the ordinary send wire.
  //
  // The mode stays open until the server answers, so a refusal or a failure
  // leaves the reader's words where they typed them instead of closing the bar
  // on an edit that never happened.
  const commitEdit = useCallback(
    (edits: { index: number; text: string }[]) => {
      const open = edit
      if (!sessionId || !open) {
        return
      }
      // Nothing changed: leaving the mode is the whole of it, rather than
      // forking the conversation to re-run it unaltered.
      if (edits.length === 0) {
        setEdit(undefined)
        return
      }
      editAgentTurn(sessionId, open.eventIndex, edits)
        .then((meta) => {
          if (!meta) {
            toast.error('That message is no longer in this conversation', {
              description: 'The edit was not applied.',
            })
            return
          }
          setEdit(undefined)
          setTurnActive(false)
          setSessionId(meta.id)
        })
        .catch((error: unknown) => {
          toast.error('Failed to edit message', {
            description: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [edit, sessionId],
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || turnActive) return
      let id = sessionId
      // No session yet → start one from the active profile, then send.
      if (!id) {
        if (!canStart) {
          toast.error('Configure the agent profile first')
          return
        }
        try {
          const meta = await startAgentSession(selection)
          resetSessionState()
          id = meta.id
          setSessionId(meta.id)
          setCanFork(meta.canFork ?? false)
        } catch (error) {
          toast.error('Failed to start session', {
            description: error instanceof Error ? error.message : String(error),
          })
          return
        }
      }
      setTurnActive(true)
      void sendAgentPrompt(id, text, 'wait')
    },
    [turnActive, sessionId, canStart, selection, resetSessionState],
  )

  const stop = useCallback(() => {
    if (sessionId) void cancelAgentTurn(sessionId)
  }, [sessionId])

  const setMode = useCallback(
    async (modeId: string) => {
      if (!sessionId) return
      setCurrentMode(modeId)
      await setAgentMode(sessionId, modeId)
    },
    [sessionId],
  )

  // Change one of the session's advertised config options (model/effort/mode/
  // …). Applies to this session only — never written back into the active
  // profile, which stays defaults-only for future sessions.
  const setConfigOption = useCallback(
    async (configId: string, value: string | boolean) => {
      if (!sessionId) return
      await setAgentConfigOption(sessionId, configId, value)
    },
    [sessionId],
  )

  // Drop a held prompt before it's delivered. A no-op for an id the server
  // no longer has (e.g. it was already delivered as the queue was draining).
  const removeQueued = useCallback(
    (id: string) => {
      if (!sessionId) return
      setQueue((prev) => prev.filter((item) => item.id !== id))
      void removeQueuedPrompt(sessionId, id)
    },
    [sessionId],
  )

  // Guidance queued by "tell what to do different", sent once the run it
  // interrupted has fully stopped (a prompt can't be sent mid-turn).
  const pendingPrompt = useRef<string | null>(null)

  // "Tell what to do different": ACP can't attach a reason to a rejection, so we
  // reject the request, stop the current run, then send the typed guidance as a
  // fresh prompt once the turn ends.
  const respondPermissionText = useCallback(
    (requestId: string, text: string) => {
      respondPermission(requestId)
      const value = text.trim()
      if (!value || !sessionId) return
      if (turnActive) {
        void cancelAgentTurn(sessionId)
        pendingPrompt.current = value
      } else {
        setTurnActive(true)
        void sendAgentPrompt(sessionId, value, 'wait')
      }
    },
    [sessionId, turnActive],
  )

  // Flush the queued guidance once the interrupted run has stopped.
  useEffect(() => {
    if (turnActive || !pendingPrompt.current || !sessionId) return
    const text = pendingPrompt.current
    pendingPrompt.current = null
    setTurnActive(true)
    void sendAgentPrompt(sessionId, text, 'wait')
  }, [turnActive, sessionId])

  // The named session-shape contract (session.ts) this controller satisfies,
  // so a host can hand it straight to <AgentChat> and <Approvals> instead of
  // redrawing the same mapping per application. The `satisfies` pin is here,
  // at the construction site, per the contract's own note: a field renamed or
  // dropped on either side fails to typecheck here rather than surfacing as a
  // prop-shape mismatch somewhere downstream.
  const session = useMemo(
    () =>
      ({
        sessionKey: sessionId ?? '',
        loading,
        sending: starting,
        waiting: turnActive,
        botName: name,
        adapterId: selection.adapterId,
        send,
        stop,
        // The engine's resolution, read off the session start's meta: the
        // native harness rewinds its own store, an external ACP agent that
        // advertised `session/fork` forks its own transcript.
        canFork,
        editMessage: startEdit,
        edit,
        cancelEdit,
        commitEdit,
        disabled: !sessionId && !canStart,
        permissions: pending.permissions,
        asks: pending.asks,
        resolvePermission: respondPermission,
        respondPermissionText,
        resolveAsk: respondAsk,
        clearSession: clear,
      }) satisfies AgentChatSession,
    [
      sessionId,
      loading,
      starting,
      turnActive,
      name,
      selection.adapterId,
      canFork,
      send,
      stop,
      edit,
      startEdit,
      cancelEdit,
      commitEdit,
      canStart,
      pending,
      respondPermissionText,
      clear,
    ],
  )

  return {
    // the contract shape a host hands to <AgentChat> / <Approvals>
    session,
    // profiles + preset editing
    profiles,
    activeId,
    name,
    setName,
    selection,
    updateSelection,
    switchProfile,
    newProfile,
    deleteProfile,
    saveProfile,
    // roles (tool/skill permissions assigned to the profile)
    roles,
    roleIds,
    setRoleIds,
    // model discovery
    loadedModels,
    loadingModels,
    loadModels,
    // session + transcript
    sessionId,
    loading,
    blocks,
    kitBlocks,
    // Whether anything has been exchanged at all — not the same question as
    // `kitBlocks.length > 0`, since a message can fold to no renderable block.
    hasMessages: messages.length > 0,
    turnActive,
    modes,
    currentMode,
    configOptions,
    setConfigOption,
    // agent-advertised slash commands (composer autocomplete)
    commands,
    usage,
    starting,
    canStart,
    start,
    clear,
    send,
    stop,
    fork,
    setMode,
    // prompts held server-side while a turn was active
    queue,
    removeQueued,
    // composer input
    input,
    setInput,
    // request responders
    respondPermission,
    respondPermissionText,
    respondAsk,
  }
}

export type AgentSessionController = ReturnType<typeof useAgentSession>
