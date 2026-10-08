import assert from 'node:assert/strict'
import test from 'node:test'

import { claimTabId, type TabStorage } from './tab-identity'

class MemoryStorage implements TabStorage {
  constructor(private readonly items = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
  /** What a duplicated tab starts with. */
  copy(): MemoryStorage {
    return new MemoryStorage(new Map(this.items))
  }
}

function pageTransition(type: 'pagehide' | 'pageshow', persisted: boolean): Event {
  return Object.assign(new Event(type), { persisted })
}

function ids(...values: string[]): () => string {
  return () => {
    const next = values.shift()
    assert.ok(next, 'asked for more new ids than the test expected')
    return next
  }
}

test('a first page load takes a new id', () => {
  assert.equal(claimTabId(new MemoryStorage(), new EventTarget(), ids('id-1')), 'id-1')
})

test('a reload of the tab takes the id the page before it had', () => {
  const storage = new MemoryStorage()
  const before = new EventTarget()
  const first = claimTabId(storage, before, ids('id-1'))
  before.dispatchEvent(pageTransition('pagehide', false))
  assert.equal(claimTabId(storage, new EventTarget(), ids('id-2')), first)
})

test('a tab duplicated while the page lives takes an id of its own', () => {
  const storage = new MemoryStorage()
  const first = claimTabId(storage, new EventTarget(), ids('id-1'))
  assert.notEqual(claimTabId(storage.copy(), new EventTarget(), ids('id-2')), first)
})

test('a page back from the back-forward cache takes its id out of storage again', () => {
  const storage = new MemoryStorage()
  const page = new EventTarget()
  const first = claimTabId(storage, page, ids('id-1'))
  page.dispatchEvent(pageTransition('pagehide', true))
  page.dispatchEvent(pageTransition('pageshow', true))
  assert.notEqual(claimTabId(storage.copy(), new EventTarget(), ids('id-2')), first)
  page.dispatchEvent(pageTransition('pagehide', false))
  assert.equal(claimTabId(storage, new EventTarget(), ids('id-3')), first)
})
