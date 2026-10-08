/**
 * Which browser tab this page is, stable across reloads of that tab and different in every other
 * tab, so each tab's terminals get shells of their own.
 *
 * `sessionStorage` is the per-tab store that survives a reload, but a duplicated tab starts with a
 * copy of it. So the id is taken out of storage while the page lives and written back only as the
 * page goes: a reload finds it, and a copy taken in between does not.
 */

const STORAGE_KEY = 'opencroft.terminal.tab-id'

/** The part of `Storage` this needs. */
export interface TabStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** `window`, as far as the page lifecycle goes. */
export interface PageLifecycle {
  addEventListener(type: 'pagehide' | 'pageshow', listener: (event: Event) => void): void
}

/** Take this tab's id out of `storage`, or a new one, and put it back whenever the page is hidden. */
export function claimTabId(storage: TabStorage, page: PageLifecycle, newId: () => string): string {
  const id = storage.getItem(STORAGE_KEY) ?? newId()
  storage.removeItem(STORAGE_KEY)
  page.addEventListener('pagehide', () => storage.setItem(STORAGE_KEY, id))
  // Back from the back-forward cache, the page is live again and the id must leave storage again.
  page.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) {
      storage.removeItem(STORAGE_KEY)
    }
  })
  return id
}

// `crypto.randomUUID` exists only in secure contexts; `getRandomValues` exists everywhere.
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Storage can be switched off or throw on access. Without it the id lasts one page load, and a
// reload opens a fresh shell.
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

let current: string | undefined

/** This tab's id. Browser only: the first call claims it for the page. */
export function browserTabId(): string {
  if (current === undefined) {
    const storage = sessionStorageOrNull()
    current = storage ? claimTabId(storage, window, randomId) : randomId()
  }
  return current
}
