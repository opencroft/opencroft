// How a stored avatar reaches a browser: the address a page is given, and what
// that address answers. Against a real database, because what is served is
// whatever the `user` row holds at the moment of the request.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { beforeEach } from 'node:test'

process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations')
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'development'

const { db, user } = await import('@opencroft/db')
const { eq } = await import('drizzle-orm')
const { avatarResponse, readStoredAvatar, userAvatarUrl } = await import('./user-avatar')

// Two different, tiny "pictures". Their bytes only need to round-trip.
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 4, 5, 6])
const PNG = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`
const JPEG = `data:image/jpeg;base64,${Buffer.from(JPEG_BYTES).toString('base64')}`

beforeEach(async () => {
  await db.delete(user)
})

async function person(id: string, image: string | null): Promise<{ id: string; image: string | null }> {
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: false, image })
  return { id, image }
}

// What the browser gets when it loads `address` for `userId`.
async function load(userId: string, address: string, headers: Record<string, string> = {}): Promise<Response> {
  return avatarResponse(new Request(new URL(address, 'http://localhost'), { headers }), await readStoredAvatar(userId))
}

test('an uploaded picture is given a versioned address that serves its bytes, cached for good', async () => {
  const alice = await person('alice', PNG)
  const address = userAvatarUrl(alice)
  assert.match(address ?? '', /^\/api\/avatars\/alice\?v=[0-9a-f]{16}$/)

  const response = await load('alice', address ?? '')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES)
})

test('a new picture gets a new address, and the old address no longer caches for good', async () => {
  const before = userAvatarUrl(await person('bob', PNG)) ?? ''
  await db.update(user).set({ image: JPEG }).where(eq(user.id, 'bob'))
  const after = userAvatarUrl({ id: 'bob', image: JPEG }) ?? ''
  assert.notEqual(after, before)

  // The superseded address answers with the current picture, revalidated on
  // every use, so it can never be cached as the old version.
  const stale = await load('bob', before)
  assert.equal(stale.status, 200)
  assert.equal(stale.headers.get('Cache-Control'), 'private, no-cache')
  assert.deepEqual(new Uint8Array(await stale.arrayBuffer()), JPEG_BYTES)
})

test('a revalidation for the picture the browser already holds is answered without the bytes', async () => {
  const address = userAvatarUrl(await person('carol', PNG)) ?? ''
  const first = await load('carol', address)
  const etag = first.headers.get('ETag') ?? ''
  assert.ok(etag)

  const again = await load('carol', address, { 'If-None-Match': etag })

  assert.equal(again.status, 304)
  assert.equal(await again.text(), '')
})

test('an account without a picture has no address, and its avatar route answers 404 uncached', async () => {
  const dave = await person('dave', null)
  assert.equal(userAvatarUrl(dave), null)

  const response = await load('dave', '/api/avatars/dave')

  assert.equal(response.status, 404)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('a picture hosted elsewhere is passed through as its own address and not served here', async () => {
  const erin = await person('erin', 'https://images.example.com/erin.png')
  assert.equal(userAvatarUrl(erin), 'https://images.example.com/erin.png')
  assert.equal(await readStoredAvatar('erin'), null)
})

test('a stored data URL of a type the upload never accepts is not served as an image', async () => {
  await person('frank', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)
  assert.equal(await readStoredAvatar('frank'), null)
})

test('an account id is escaped into the address', () => {
  assert.match(userAvatarUrl({ id: 'a/b?c', image: PNG }) ?? '', /^\/api\/avatars\/a%2Fb%3Fc\?v=/)
})
