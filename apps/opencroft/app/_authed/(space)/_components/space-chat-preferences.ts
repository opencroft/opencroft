import type { DockSide } from 'ui/layouts/dock-panel'

// ONE ARRANGEMENT FOR THE PERSON, NOT ONE PER SPACE. Where the chat sits, how
// wide it is and whether it is open follow the reader from space to space:
// opening a different space shows the chat where this browser left it.
//
// It was the other way round until 30.08.2026, a key per space -- and per-space
// had been asked for explicitly. The reversal is just as deliberate,
// so anyone who finds an older instruction saying "per space" is reading the
// superseded one and should not key these back to a slug.
//
// Per browser rather than per account, because this is local storage: the
// arrangement does not follow the reader to another machine. That is inherent
// to where it is stored, not a decision taken here.
export const CHAT_DOCK_KEY = 'opencroft.spaceChat.dock'
export const CHAT_OPEN_KEY = 'opencroft.spaceChat.open'
export const CHAT_SIZE_KEY = 'opencroft.spaceChat.size'

export const CHAT_DOCK_DEFAULT: DockSide = 'right'
export const CHAT_OPEN_DEFAULT = false

// The keys the three above replaced: one set per space, so a browser that has
// visited a dozen spaces holds up to three dozen of them.
const PER_SPACE_KEY = /^opencroft\.space\..+\.chat(Dock|Open|Size)$/

// Only what the walk needs. `length` and `key` are how an unknown set of keys is
// enumerated at all -- there is no prefix query -- and `removeItem` is the whole
// mutation.
type EnumerableStorage = Pick<Storage, 'key' | 'removeItem'> & { readonly length: number }

/**
 * Delete every per-space chat preference this browser still holds, and report
 * which ones went.
 *
 * NOTHING IS CARRIED OVER, AND THAT IS THE DECISION RATHER THAN AN OVERSIGHT.
 * The global setting starts at its default and the reader adjusts it once. There
 * is deliberately no migration: no vote across the old values, no "the last
 * space wins", no seeding the new key from an old one. Anyone who finds these
 * keys dropped and reads it as forgetfulness would be reintroducing a behaviour
 * that was considered and turned down.
 *
 * Every key is collected before any is removed. Removing inside the walk shifts
 * each later index down by one, so the walk steps over the next key every time
 * and leaves roughly half of them behind -- and it would look like it worked.
 */
export function dropPerSpaceChatPreferences(storage: EnumerableStorage): string[] {
  const stale: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null && PER_SPACE_KEY.test(key)) {
      stale.push(key)
    }
  }
  for (const key of stale) {
    storage.removeItem(key)
  }
  return stale
}
