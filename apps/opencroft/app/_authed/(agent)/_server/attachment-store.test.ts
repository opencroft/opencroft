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

import { chatAttachment, db } from '@opencroft/db'
import { count, eq } from 'drizzle-orm'
import sharp from 'sharp'

import {
  AttachmentRejected,
  clearAttachments,
  loadAttachments,
  MAX_ATTACHMENT_BYTES,
  moveAttachments,
  readAttachment,
  resolveAttachmentRefs,
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

test("a send's ids resolve to what the store says they are, in the order they were given", async () => {
  // The name and type a message records come from the row, never from the
  // caller -- the wire carries ids and nothing a sender could relabel.
  const key = nextKey()
  const first = await png(key, 'first.png')
  const second = await png(key, 'second.png')
  assert.deepEqual(await resolveAttachmentRefs(key, [second.id, first.id]), [
    { id: second.id, name: 'second.png', mimeType: 'image/png' },
    { id: first.id, name: 'first.png', mimeType: 'image/png' },
  ])
  assert.deepEqual(await resolveAttachmentRefs(key, []), [])
})

// A solid picture of the given size, as the base64 the store takes.
function canvas(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } })
}
const base64 = async (image: sharp.Sharp) => (await image.toBuffer()).toString('base64')

test('a picture resolves with the size it displays at, read from its bytes', async () => {
  const key = nextKey()
  const wide = await saveAttachment({
    sessionKey: key,
    name: 'wide.png',
    mimeType: 'image/png',
    data: await base64(canvas(30, 20).png()),
  })
  // Stored sideways with an orientation that says "turn it": a browser draws
  // it upright, so the size it takes on the page is the turned one.
  const turned = await saveAttachment({
    sessionKey: key,
    name: 'turned.jpg',
    mimeType: 'image/jpeg',
    data: await base64(canvas(30, 20).jpeg().withMetadata({ orientation: 6 })),
  })
  // An animation is laid out as one of its frames, not as the strip of all of them.
  const frame = await canvas(10, 8).png().toBuffer()
  const animated = await saveAttachment({
    sessionKey: key,
    name: 'loop.gif',
    mimeType: 'image/gif',
    data: await base64(sharp([frame, frame], { join: { animated: true } }).gif()),
  })
  assert.deepEqual(await resolveAttachmentRefs(key, [wide.id, turned.id, animated.id]), [
    { id: wide.id, name: 'wide.png', mimeType: 'image/png', width: 30, height: 20 },
    { id: turned.id, name: 'turned.jpg', mimeType: 'image/jpeg', width: 20, height: 30 },
    { id: animated.id, name: 'loop.gif', mimeType: 'image/gif', width: 10, height: 8 },
  ])
})

test('a picture whose bytes do not say their size is still stored, and resolves without one', async () => {
  const key = nextKey()
  const stored = await png(key, 'unreadable.png')
  const [row] = await db
    .select({ width: chatAttachment.width, height: chatAttachment.height })
    .from(chatAttachment)
    .where(eq(chatAttachment.id, stored.id))
  assert.deepEqual(row, { width: null, height: null })
  assert.deepEqual(await resolveAttachmentRefs(key, [stored.id]), [
    { id: stored.id, name: 'unreadable.png', mimeType: 'image/png' },
  ])
})

test("a send naming another conversation's picture is refused, not quietly thinned", async () => {
  const mine = nextKey()
  const theirs = nextKey()
  const ours = await png(mine, 'mine.png')
  const other = await png(theirs, 'theirs.png')
  await assert.rejects(resolveAttachmentRefs(mine, [ours.id, other.id]), AttachmentRejected)
  await assert.rejects(resolveAttachmentRefs(mine, ['00000000-0000-0000-0000-000000000000']), AttachmentRejected)
})

// The embedded PGlite builds a whole result in its wasm memory. Four images
// this size in one query ran it out of memory, and every query after failed
// until the process restarted: one user's send took the instance down.
test('six images at the size ceiling load in one delivery, and the database stays usable', async () => {
  const key = nextKey()
  // The largest payload the ceiling admits, as base64.
  const data = 'R'.repeat(Math.floor((MAX_ATTACHMENT_BYTES * 4) / 3))
  const ids: string[] = []
  for (let i = 0; i < 6; i += 1) {
    ids.push((await saveAttachment({ sessionKey: key, name: `big-${i}.gif`, mimeType: 'image/gif', data })).id)
  }
  const loaded = await loadAttachments(key, ids)
  assert.deepEqual(
    loaded.map((row) => [row.id, row.data.length]),
    ids.map((id) => [id, data.length]),
  )
  const [row] = await db.select({ rows: count() }).from(chatAttachment).where(eq(chatAttachment.sessionKey, key))
  assert.equal(row.rows, 6, 'a query after the load still runs')
  // A rename and a retirement touch every row of a key in one statement, and
  // read none of the bytes back.
  const renamed = nextKey()
  await moveAttachments([{ from: key, to: renamed }])
  assert.equal((await loadAttachments(renamed, [ids[0]])).length, 1)
  await clearAttachments(renamed)
  const [left] = await db.select({ rows: count() }).from(chatAttachment).where(eq(chatAttachment.sessionKey, renamed))
  assert.equal(left.rows, 0)
})

test('a refusal over the ceiling states both sizes to one decimal', async () => {
  // About 4.2 MiB decoded: rounded to whole megabytes this read "4 MB, over the 4 MB limit".
  const data = 'A'.repeat(Math.ceil(4.2 * 1024 * 1024 * (4 / 3)))
  await assert.rejects(
    saveAttachment({ sessionKey: nextKey(), name: 'big.gif', mimeType: 'image/gif', data }),
    (error: unknown) =>
      error instanceof AttachmentRejected && error.message === 'that image is 4.2 MB, over the 4.0 MB limit',
  )
})
