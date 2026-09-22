// The store behind an attached image, against a real database.
//
// What belongs here is what only a database can get wrong: that an id from
// another conversation resolves to nothing, that the bytes come back in the
// order the message named them rather than the order the rows arrived in, that
// a retirement takes the pictures with it, and that a rename carries them.
// What a message DOES with the reference is tested in agent-client.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AttachmentRejected,
  clearAttachments,
  loadAttachments,
  MAX_ATTACHMENT_BYTES,
  moveAttachments,
  readAttachment,
  saveAttachment,
} from './attachment-store'

let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:attachments-${counter}`
}

const png = (sessionKey: string, name: string, data = 'AAAA') =>
  saveAttachment({ sessionKey, name, mimeType: 'image/png', data })

test('a stored image comes back by id, with the size the bytes really are', async () => {
  const key = nextKey()
  // 'AAAA' is four base64 characters with no padding — three bytes.
  const stored = await png(key, 'shot.png')
  assert.deepEqual(await loadAttachments(key, [stored.id]), [
    { id: stored.id, name: 'shot.png', mimeType: 'image/png', data: 'AAAA' },
  ])
  assert.equal(stored.byteSize, 3)
})

test('padding is counted out of the size rather than into it', async () => {
  const key = nextKey()
  assert.equal((await png(key, 'a.png', 'AA==')).byteSize, 1)
  assert.equal((await png(key, 'b.png', 'AAA=')).byteSize, 2)
})

test("another conversation's id resolves to nothing", async () => {
  // Message text is editable, so an id is not a capability. This is the whole
  // reason the loader takes a session key at all.
  const mine = nextKey()
  const theirs = nextKey()
  const stored = await png(theirs, 'theirs.png')
  assert.deepEqual(await loadAttachments(mine, [stored.id]), [])
  assert.equal(await readAttachment(mine, stored.id), null)
})

test('the bytes come back in the order the message named them', async () => {
  const key = nextKey()
  const first = await png(key, 'first.png', 'AAAA')
  const second = await png(key, 'second.png', 'BBBB')
  assert.deepEqual(
    (await loadAttachments(key, [second.id, first.id])).map((row) => row.name),
    ['second.png', 'first.png'],
  )
})

test('an id that names no row is absent rather than fatal', async () => {
  // The engine reports the shortfall in the transcript; a throw here would
  // cost the message its text as well as its picture.
  const key = nextKey()
  const stored = await png(key, 'shot.png')
  assert.deepEqual(
    (await loadAttachments(key, ['no-such-id', stored.id])).map((row) => row.id),
    [stored.id],
  )
})

test('a file type no endpoint here accepts is refused', async () => {
  const key = nextKey()
  await assert.rejects(
    saveAttachment({ sessionKey: key, name: 'notes.pdf', mimeType: 'application/pdf', data: 'AAAA' }),
    AttachmentRejected,
  )
  // An SVG is a script host rather than a picture, and is refused with the rest.
  await assert.rejects(
    saveAttachment({ sessionKey: key, name: 'x.svg', mimeType: 'image/svg+xml', data: 'AAAA' }),
    AttachmentRejected,
  )
})

test('an empty payload is refused, and so is one over the ceiling', async () => {
  const key = nextKey()
  await assert.rejects(
    saveAttachment({ sessionKey: key, name: 'x.png', mimeType: 'image/png', data: '' }),
    AttachmentRejected,
  )
  const tooBig = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) * (4 / 3)))
  await assert.rejects(
    saveAttachment({ sessionKey: key, name: 'huge.png', mimeType: 'image/png', data: tooBig }),
    AttachmentRejected,
  )
})

test('retiring a key takes its pictures with it, and only its own', async () => {
  const mine = nextKey()
  const theirs = nextKey()
  const ours = await png(mine, 'mine.png')
  const other = await png(theirs, 'theirs.png')
  await clearAttachments(mine)
  assert.deepEqual(await loadAttachments(mine, [ours.id]), [])
  assert.equal((await loadAttachments(theirs, [other.id])).length, 1)
})

test('a rename carries the pictures onto the new key', async () => {
  // Left behind they are worse than unreachable: the chips stay in the
  // messages, and the rows are bytes no retirement could ever find.
  const from = nextKey()
  const to = nextKey()
  const stored = await png(from, 'shot.png')
  await moveAttachments([{ from, to }])
  assert.deepEqual(await loadAttachments(from, [stored.id]), [])
  assert.equal((await loadAttachments(to, [stored.id])).length, 1)
})
