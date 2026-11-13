// How the Instructions tab saves a place's shared text: at the version it
// read, one save at a time, holding a refused save as a conflict until the
// person picks a text. Free of React and of the host's modules, so it runs
// under test; use-shared-instructions.ts is its React side.

/** The shared text as read: its text and the row version a save is applied at. */
export interface SharedText {
  text: string
  version: number
}

/** A save refused because someone else saved first: what is there now. */
export interface SharedConflict extends SharedText {
  updatedBy?: string
}

/** What a write answers (the host's HostAgentInstructionsWrite). */
export interface SharedWriteAnswer {
  version?: number
  conflict?: SharedConflict
}

export type SharedWrite = (text: string, expectedVersion: number) => Promise<SharedWriteAnswer>

export interface SharedSaverState {
  /** The text in the editor. */
  value: string
  saving: boolean
  /** The last save's failure, until a save succeeds. */
  error: string
  /** Set while a save was refused and the person has not picked a text. */
  conflict: SharedConflict | null
}

/**
 * The editor's text and what is saved of it. `save` writes the current text
 * at the version last read or saved; saves are chained, so each starts with
 * the text and version current when its turn comes and none goes out at a
 * version an earlier one replaced. A refused save writes nothing and is held
 * as `conflict`, and no save is made until `takeTheirs` or `keepMine`.
 */
export class SharedTextSaver {
  private state: SharedSaverState
  private version: number
  // The text the stored version holds, as far as this editor knows.
  private saved: string
  private chain: Promise<void> = Promise.resolve()

  constructor(
    read: SharedText,
    private readonly write: SharedWrite,
    private readonly onState: (state: SharedSaverState) => void,
  ) {
    this.state = { value: read.text, saving: false, error: '', conflict: null }
    this.version = read.version
    this.saved = read.text
  }

  get current(): SharedSaverState {
    return this.state
  }

  /** Whether the editor holds text no save has stored. */
  get dirty(): boolean {
    return this.state.value !== this.saved
  }

  private set(patch: Partial<SharedSaverState>): void {
    this.state = { ...this.state, ...patch }
    this.onState(this.state)
  }

  /** A fresh read: taken only while nothing typed is unsaved and no conflict waits. */
  adoptRead(read: SharedText): void {
    if (this.dirty || this.state.conflict) {
      return
    }
    this.version = read.version
    this.saved = read.text
    this.set({ value: read.text })
  }

  edit(text: string): void {
    this.set({ value: text })
  }

  save(): Promise<void> {
    this.chain = this.chain.then(() => this.saveNow())
    return this.chain
  }

  private async saveNow(): Promise<void> {
    const text = this.state.value
    if (this.state.conflict || text === this.saved) {
      return
    }
    this.set({ saving: true })
    try {
      const answer = await this.write(text, this.version)
      if (answer.conflict) {
        this.set({ saving: false, conflict: answer.conflict })
        return
      }
      this.version = answer.version ?? this.version
      this.saved = text
      this.set({ saving: false, error: '' })
    } catch (e) {
      this.set({ saving: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Drop this editor's text for the one the conflict found. */
  takeTheirs(): void {
    const conflict = this.state.conflict
    if (!conflict) {
      return
    }
    this.version = conflict.version
    this.saved = conflict.text
    this.set({ value: conflict.text, conflict: null })
  }

  /** Save this editor's text over the one the conflict found. */
  keepMine(): Promise<void> {
    const conflict = this.state.conflict
    if (!conflict) {
      return this.chain
    }
    this.version = conflict.version
    this.saved = conflict.text
    this.set({ conflict: null })
    return this.save()
  }
}
