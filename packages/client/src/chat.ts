/**
 * `@opencroft/client/chat` — the host's chat surface, offered whole so an
 * extension mounts the host's own conversation rather than arranging the
 * pieces: the dock chrome, the embedded thread, the picker that chooses which
 * thread it shows, the selection that rides along with a message, and the
 * accounts behind `@<username>` mentions; and the two places an extension adds
 * to the host's agent chat, its `agent-chat-input-controls` and
 * `agent-chat-status-indicators` provider points.
 */
import type { ComponentType, FC, ReactNode } from 'react'

/** Which conversation an embedded chat surface shows. */
export type EmbeddedChatSelection = { threadId: string } | { newId: string }

export interface EmbeddedAgentChatProps {
  /** The group chat's slug — the first segment of every thread session key. */
  space: string
  /** The DEFAULT thread slug this surface owns, one per member agent. */
  id: string
  /** Override the shown conversation. Unset = the default thread. */
  thread?: EmbeddedChatSelection | null
  /**
   * What to NAME the chat if this surface has to create it. The address is
   * always `space`; this is only the display name, and it defaults to the slug
   * when a host has no better one.
   */
  title?: string
  /**
   * Reports whether the chat RESOLVED: true only when it exists and the caller
   * can see it, false while loading and when it is missing, refused or failed.
   */
  onChatAvailable?: (available: boolean) => void
  className?: string
}
export declare const EmbeddedAgentChat: FC<EmbeddedAgentChatProps>

export interface ChatSelectorProps {
  /** The group chat's slug — same address the embedded chat surface takes. */
  space: string
  /** The current selection, so the open menu can mark the active thread. */
  selection?: EmbeddedChatSelection | null
  onChange: (selection: EmbeddedChatSelection) => void
  /** A larger tap target for touch surfaces; default is the compact header button. */
  size?: 'icon' | 'icon-sm' | 'icon-xs'
  className?: string
}
export declare const ChatSelector: FC<ChatSelectorProps>

export interface ChatDockProps {
  /** The group chat's address: the space's slug. */
  space: string
  /** The thread slug this surface addresses by default. */
  id: string
  /** What the panel's header calls the conversation. */
  title: string
  /** The chat's display name, used only if it has to be created. */
  chatName?: string
  /** The surface the chat sits beside, floats over, or covers. */
  children: ReactNode
}
/**
 * The whole chrome around an embedded thread — corner launcher, the three
 * docks plus the floating window, the mobile cover and its Back behaviour.
 * Where the panel sits is remembered in the reader's browser per App type, so
 * an App gets its own position without passing anything.
 */
export declare const ChatDock: FC<ChatDockProps>

/** What the surface inside a `ChatDock` can ask of the dock around it. */
export interface ChatDockControl {
  /** The chat this dock shows: the slug it was given as `space`. */
  space: string
  /**
   * Opens the panel (the full-screen cover on a phone) on this thread of the
   * dock's chat. It becomes the remembered conversation, as if picked on the
   * chat's home; the panel's position and size stay as the reader left them.
   */
  openThread: (threadId: string) => void
}
/** The `ChatDock` around the calling surface, or null when it has none. */
export declare const useChatDock: () => ChatDockControl | null

export interface UserSelection {
  /** What the quotation shows. Presentation only — never sent to the agent. */
  label: string
  /** What the agent receives when passing is on. */
  content: string
}

/**
 * What the reader has selected on the surface the chat sits beside, and
 * whether it rides along with the next message.
 */
export interface SelectionContextValue {
  /** The current selection, or null when nothing is selected. */
  selection: UserSelection | null
  /**
   * Whether a selection rides along with the next message. A standing
   * preference of the reader rather than a property of what is selected:
   * publishing a selection does not touch it, and it can be set with nothing
   * selected at all. Kept per browser, so every scope starts from the reader's
   * last answer.
   */
  passEnabled: boolean
  setSelection: (selection: UserSelection | null) => void
  clearSelection: () => void
  togglePass: () => void
}

export declare const SelectionProvider: FC<{ children: ReactNode }>
/** Throws outside a `SelectionProvider` rather than returning an empty scope. */
export declare const useSelection: () => SelectionContextValue

/** One account a username names: what the directory already shows any signed-in member. */
export interface MentionedAccount {
  kind: 'user' | 'agent'
  name: string
  avatarUrl: string | null
  /** The handle the account goes by now, which differs from the one asked about when that one is retired. */
  username: string
}

/**
 * The accounts holding these usernames -- or that used to, since a retired
 * handle still resolves to its account. A username no account holds is absent.
 */
export declare const describeMentionedAccounts: (usernames: string[]) => Promise<Record<string, MentionedAccount>>

/** One message of the agent chat, as an input control reads it: its text is in the parts of type `text`. */
export interface AgentChatMessage {
  role: 'user' | 'assistant'
  parts: { type: string; text?: string }[]
  timestamp: number
}

/** What the host hands an `agent-chat-input-controls` entry, rendered beside the agent chat's composer. */
export interface AgentChatInputControlProps {
  /** The active agent's node id; a control resolves its own configuration from it (e.g. speech settings). */
  agentNodeId: string
  /** Append text to the composer draft. */
  insertText: (text: string) => void
  /** Send a message as the user. */
  send: (text: string) => void
  /** Read the live message list (e.g. to speak the latest reply). */
  getMessages: () => AgentChatMessage[]
  /** True while the agent is generating a reply; flips false when the turn completes. */
  streaming: boolean
}

/** An entry of the `agent-chat-input-controls` provider point: a control beside the agent chat's composer (e.g. a microphone). */
export interface AgentChatInputControl {
  id: string
  component: ComponentType<AgentChatInputControlProps>
}

/**
 * An entry of the `agent-chat-status-indicators` provider point, rendered at
 * the foot of the chat's message list, beside the thinking indicator. It is
 * mounted for as long as the chat is and decides itself when it shows (e.g. a
 * playback visualizer that appears only while audio plays).
 */
export interface AgentChatStatusIndicator {
  id: string
  component: ComponentType
}
