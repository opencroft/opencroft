// The directory read, against a real database and real sessions.
//
// The assertion that matters most here is a NEGATIVE one. This read exists so
// a picker can show names, and the decision that allowed it was explicitly
// bounded: id, name, avatar, and nothing else. A later change that quietly
// adds email or role to the row would satisfy every positive test and break
// the terms the exposure was agreed on, so the shape is pinned by checking
// what must NOT be there.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-directory-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'development'

const directory = await import('./user-directory')
const { GroupChatAccessError } = await import('@/app/_authed/(group-chats)/_shared/access-error')
const { ensureAuth } = await import('@opencroft/auth/server')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function makeUser(email: string, name: string): Promise<{ id: string; cookie: string }> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name, email, password: 'password123456' },
    asResponse: true,
  })
  const setCookie = result.headers.get('set-cookie')
  assert.ok(setCookie)
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie)
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

function reqAs(cookie: string): Request {
  return new Request('http://localhost:9999/', { headers: { cookie } })
}

test('a signed-in non-admin can list people to pick from', async () => {
  const alice = await makeUser('dir-alice@example.test', 'Alice Example')
  await makeUser('dir-bob@example.test', 'Bob Example')

  // Deliberately as a plain user, not an admin: the whole point of this read
  // is that adding a member does not require administrator rights, which the
  // admin-only user list would have forced.
  const people = await directory.listDirectoryUsers(reqAs(alice.cookie))

  const names = people.map((p) => p.name)
  assert.ok(names.includes('Alice Example'))
  assert.ok(names.includes('Bob Example'), 'a non-admin must be able to see another account to pick it')
})

// THE BOUNDARY THE EXPOSURE WAS AGREED ON.
test('it returns id, name and avatar — and nothing else', async () => {
  const alice = await makeUser('dir-shape@example.test', 'Shape Example')
  const people = await directory.listDirectoryUsers(reqAs(alice.cookie))
  const row = people.find((p) => p.name === 'Shape Example')
  assert.ok(row)

  assert.deepEqual(
    Object.keys(row).sort(),
    ['avatarUrl', 'id', 'name'],
    'the shape is the agreement — adding a field here widens what every signed-in account can read',
  )

  // Belt-and-braces against a field arriving under a different name: the
  // address must not be reachable from the serialised row at all.
  const serialised = JSON.stringify(people)
  assert.equal(serialised.includes('dir-shape@example.test'), false, 'no email may reach the client')
  assert.equal(serialised.includes('"role"'), false, 'no role may reach the client')
  assert.equal(serialised.includes('banned'), false, 'no sign-in state may reach the client')
})

// The second consumer: extensions, through `host.users`. The same read, so the
// same boundary — pinned here too, because a widening could arrive on either side.
test("an extension's host.users returns the same three fields and nothing else", async () => {
  await makeUser('dir-host@example.test', 'Host Example')
  const { createHost } = await import('@/app/_authed/(extension-runtime)/_server/host')
  const people = await createHost('acme.directory-probe').users.list()
  const row = people.find((p) => p.name === 'Host Example')
  assert.ok(row)
  assert.deepEqual(Object.keys(row).sort(), ['avatarUrl', 'id', 'name'])
  assert.equal(JSON.stringify(people).includes('dir-host@example.test'), false, 'no email may reach an extension')
})

test('an anonymous request is refused', async () => {
  await assert.rejects(
    () => directory.listDirectoryUsers(new Request('http://localhost:9999/')),
    (error: unknown) => {
      assert.ok(error instanceof GroupChatAccessError)
      assert.equal(error.code, 'unauthenticated')
      return true
    },
    'the directory is for signed-in users, not the public',
  )
})
