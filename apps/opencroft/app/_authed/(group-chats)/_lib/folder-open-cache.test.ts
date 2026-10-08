import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
after(() => dom.cleanup())

const { folderOpenKey, readFolderOpen, writeFolderOpen } = await import('./folder-open-cache')

beforeEach(() => {
  window.localStorage.clear()
})

test('nothing stored reads as nothing toggled', () => {
  assert.deepEqual(readFolderOpen(folderOpenKey('alice', 'chat-1', 'active')), {})
})

test('a toggle is stored per folder and read back', () => {
  const key = folderOpenKey('alice', 'chat-1', 'active')
  writeFolderOpen(key, 'folder-a', false)
  writeFolderOpen(key, 'folder-b', true)
  writeFolderOpen(key, 'folder-a', true)
  assert.deepEqual(readFolderOpen(key), { 'folder-a': true, 'folder-b': true })
})

test("one person's toggle is not another's, nor another chat's or list's", () => {
  writeFolderOpen(folderOpenKey('alice', 'chat-1', 'active'), 'folder-a', false)
  assert.deepEqual(readFolderOpen(folderOpenKey('bob', 'chat-1', 'active')), {})
  assert.deepEqual(readFolderOpen(folderOpenKey('alice', 'chat-2', 'active')), {})
  assert.deepEqual(readFolderOpen(folderOpenKey('alice', 'chat-1', 'archive')), {})
})

// A snapshot that is a new object on every read makes useSyncExternalStore
// re-render without end.
test('the same stored value reads back as the same object until it changes', () => {
  const key = folderOpenKey('alice', 'chat-1', 'active')
  writeFolderOpen(key, 'folder-a', false)
  const first = readFolderOpen(key)
  assert.equal(readFolderOpen(key), first)
  writeFolderOpen(key, 'folder-a', true)
  assert.notEqual(readFolderOpen(key), first)
})

test('an unreadable entry reads as nothing toggled, and only boolean values are kept', () => {
  const key = folderOpenKey('alice', 'chat-1', 'active')
  window.localStorage.setItem(key, '{not json')
  assert.deepEqual(readFolderOpen(key), {})
  window.localStorage.setItem(key, '[true]')
  assert.deepEqual(readFolderOpen(key), {})
  window.localStorage.setItem(key, JSON.stringify({ 'folder-a': false, 'folder-b': 'yes' }))
  assert.deepEqual(readFolderOpen(key), { 'folder-a': false })
})
