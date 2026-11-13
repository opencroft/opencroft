/** `@opencroft/server/collab` — documents several people edit at once. */

/** Where one kind of an extension's markdown documents is stored, keyed by whatever the extension keys them by. */
export interface HostMarkdownDocStorage {
  /** The document's markdown as stored; null when there is no such document. */
  read(key: string): Promise<string | null>
  /** Stores the document's markdown. */
  write(key: string, markdown: string): Promise<void>
  /** Whether a signed-in person may open the document; when absent, everyone signed in may. */
  authorize?(key: string, user: { id: string; name: string }): Promise<boolean> | boolean
}

/** Who changed a markdown document from outside an editor, as the change is shown to the people editing it. */
export interface HostMarkdownEditOrigin {
  kind: 'agent' | 'user'
  name: string
}

/**
 * Documents several people edit at once, in the host's `MarkdownEditor`: a
 * document's markdown stays where the extension keeps it, and while anyone
 * has it open the host holds the shared copy, with everyone's carets, and
 * writes the markdown back. A document nobody has changed is never rewritten
 * for being opened.
 */
export interface HostCollabApi {
  markdown: {
    /** Serves the extension's documents of `kind` -- a name of its own, without a colon -- from `storage`. Call it from `load`. */
    register(kind: string, storage: HostMarkdownDocStorage): void
    /** What the extension's UI hands `MarkdownEditor` to open a document: `collab={{ document }}`. */
    documentName(kind: string, key: string): string
    /** A document's markdown as it stands: the open copy's when it is open, the stored markdown otherwise. */
    read(kind: string, key: string): Promise<string | null>
    /**
     * Changes a document's markdown as `origin`: `change` is handed the
     * markdown as it stands and returns what it should be. An open document is
     * changed in place -- what people type meanwhile survives, and every editor
     * shows the change being made -- and the change is stored before this
     * returns. Returns the new markdown.
     */
    edit(
      kind: string,
      key: string,
      origin: HostMarkdownEditOrigin,
      change: (markdown: string) => string,
    ): Promise<string>
    /** Stores now what the open documents of `kind` hold -- or only `key`'s -- rather than shortly. */
    flush(kind: string, key?: string): Promise<void>
    /**
     * Runs `change` -- a change to the storage of the documents of `kind`, or
     * of the ones `keys` names -- while none of them is open. Each open one is
     * stored first, unless `discard` drops what it holds; editors reconnect to
     * the markdown as `change` left it.
     */
    whileClosed<T>(
      kind: string,
      keys: string[] | null,
      change: () => Promise<T>,
      options?: { discard?: boolean },
    ): Promise<T>
    /**
     * Drops every document of `kind` whose key starts with `keyPrefix`, for
     * when their storage is going away (the extension's `onRemoved`): open
     * ones are closed without being stored, and the host forgets every one.
     */
    drop(kind: string, keyPrefix: string): Promise<void>
  }
}

export declare const collab: HostCollabApi
