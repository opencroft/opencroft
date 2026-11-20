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

/** A range of lines, 1-based and inclusive. */
export interface LineRange {
  from: number
  to: number
}

/**
 * One thing the reader has selected or open, as a reference an agent resolves
 * with one tool call. The host writes the call from the item's kind and fields.
 *
 * - `node`: a canvas node, on the graph at `graph` (`<space>.<graph>`).
 * - `file`: a file or folder on a terminal. `terminal` is a `remote_*` target
 *   (`<node-id>/<handle-id>`, or `<app address or uuid>/<handle-id>`); `path`
 *   is absolute or relative to the terminal's working directory; `on` is the
 *   terminal's name as the host shows it.
 * - `commit`: a commit in the repository at `repository` on a terminal (absent:
 *   the terminal's own checkout); with `path`, the call shows that file's change.
 * - `app`: anything an App's own action reads, given as the App's address, the
 *   action and its parameters. `noun` names it in counts (`['task', 'tasks']`).
 *
 * `text` is the highlighted text: of `lines` when the item has them, otherwise
 * text the surface can't place on a line (a highlight in an editor). At most
 * 4,000 characters per selection travel, the rest cut with a note.
 */
export type SelectionItem =
  | { kind: 'node'; graph: string; id: string; name: string; type: string }
  | {
      kind: 'file'
      terminal: string
      path: string
      folder?: boolean
      lines?: LineRange
      text?: string
      on?: string
    }
  | { kind: 'commit'; terminal: string; repository?: string; sha: string; subject?: string; path?: string }
  | {
      kind: 'app'
      app: string
      action: string
      params: Record<string, unknown>
      name: string
      noun?: [singular: string, plural: string]
      lines?: LineRange
      text?: string
    }

/** What a surface publishes: its items, and where the reader is. */
export interface Selection {
  items: SelectionItem[]
  /** Where the reader is, for the quote: the graph's or App's name. Default: the App's name. */
  place?: string
}

/**
 * A selection as the scope holds it: the quote (`Space › App › what`) and the
 * block the agent receives, whose first line is the quote.
 *
 * Publishing one of these instead of a `Selection` is deprecated: the host
 * composes the quote and the block from a `Selection`'s items, with the call
 * that resolves each one.
 */
export interface UserSelection {
  /** What the quotation shows. */
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
  /** Replace the selection; one with no items, and `null`, clear it. For a surface that publishes on events. */
  setSelection(selection: Selection | null): void
  /** @deprecated Publish a `Selection`: the host writes the quote and the block from its items. */
  setSelection(selection: UserSelection | null): void
  clearSelection: () => void
  togglePass: () => void
}

/**
 * A selection scope. The host mounts one around every App page and around the
 * canvas, so a surface needs none of its own; one mounted inside a scope adds
 * no second scope and publishes into the one above.
 */
export declare const SelectionProvider: FC<{ children: ReactNode }>
/** Throws outside a `SelectionProvider` rather than returning an empty scope. */
export declare const useSelection: () => SelectionContextValue

/**
 * Publish what the surface has selected, declaratively: the scope gets
 * `selection` whenever its value changes, and a clear on `null`, on an empty
 * list and when the calling component unmounts while its last value selected
 * something. Compared by value, so a
 * selection built afresh on every render publishes once. Does nothing outside
 * a scope.
 */
export declare function usePublishSelection(selection: Selection | null): void
/** @deprecated Publish a `Selection`: the host writes the quote and the block from its items. */
export declare function usePublishSelection(selection: UserSelection | null): void

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
