// Dropping the per-space chat preferences the global ones replaced.
//
// Worth a test where the width fix was not: this is our own arithmetic over an
// injected store, so it can be exercised without a laid-out browser.

import assert from 'node:assert/strict'
import test from 'node:test'

import { CHAT_DOCK_KEY, CHAT_OPEN_KEY, CHAT_SIZE_KEY, dropPerSpaceChatPreferences } from './space-chat-preferences'

// Enough of the Storage interface for the walk, backed by insertion order the
// way a real store enumerates.
function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    remaining: () => Array.from(map.keys()),
  }
}

test('every per-space chat key is dropped, and nothing else is touched', () => {
  const storage = fakeStorage({
    'opencroft.space.alpha.chatDock': '"left"',
    'opencroft.space.alpha.chatOpen': 'true',
    'opencroft.space.alpha.chatSize': '34',
    'opencroft.space.beta.chatDock': '"bottom"',
    'opencroft.groupChat.c1.lastAgent': '"someone"',
    'unrelated.key': '1',
  })

  const dropped = dropPerSpaceChatPreferences(storage)

  assert.deepEqual(
    dropped.sort(),
    [
      'opencroft.space.alpha.chatDock',
      'opencroft.space.alpha.chatOpen',
      'opencroft.space.alpha.chatSize',
      'opencroft.space.beta.chatDock',
    ],
    'it reports exactly the keys it removed',
  )
  assert.deepEqual(
    storage.remaining(),
    ['opencroft.groupChat.c1.lastAgent', 'unrelated.key'],
    'a preference belonging to another feature is left alone',
  )
})

test('a run of consecutive per-space keys is removed WHOLE, not every other one', () => {
  // The trap this pins: removing inside the walk shifts every later index down
  // by one, so the walk steps over its neighbour each time and leaves about half
  // the keys behind -- while still reporting success. Six in a row, so a
  // skip-every-other bug leaves three.
  const storage = fakeStorage({
    'opencroft.space.a.chatDock': '"left"',
    'opencroft.space.b.chatDock': '"left"',
    'opencroft.space.c.chatDock': '"left"',
    'opencroft.space.d.chatDock': '"left"',
    'opencroft.space.e.chatDock': '"left"',
    'opencroft.space.f.chatDock': '"left"',
  })

  const dropped = dropPerSpaceChatPreferences(storage)

  assert.equal(dropped.length, 6, 'all six are reported')
  assert.deepEqual(storage.remaining(), [], 'and all six are actually gone')
})

test('the global keys that replaced them are not themselves dropped', () => {
  const storage = fakeStorage({
    [CHAT_DOCK_KEY]: '"left"',
    [CHAT_OPEN_KEY]: 'true',
    [CHAT_SIZE_KEY]: '34',
  })

  assert.deepEqual(dropPerSpaceChatPreferences(storage), [], 'nothing matches')
  assert.deepEqual(storage.remaining(), [CHAT_DOCK_KEY, CHAT_OPEN_KEY, CHAT_SIZE_KEY])
})

test('a browser with nothing stored is left exactly as it was', () => {
  const storage = fakeStorage({})
  assert.deepEqual(dropPerSpaceChatPreferences(storage), [])
  assert.deepEqual(storage.remaining(), [])
})
