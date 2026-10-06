// The Nitro routes under server/routes/api/ext/[extensionId]/: which folder
// answers a request for an extension id, and what happens to a segment that is
// not an id. Real routes, a real database and Better Auth sessions, and real
// extension folders in a scratch data dir; the routes are called with the
// minimal event they read (`req` and `context.params`).
//
// The http/ route is not called here: it starts the extension's server module,
// which means compiling one. It shares extRouteParams with the two below, so
// the id check and the folder resolution are proved through those.
//
// Environment set up exactly as routes.test.ts does it, and for the same
// reason: `@opencroft/db` opens and migrates its connection at import time.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-bundle-routes-test-'))
const ENV_KEYS = ['OPENCROFT_DATA_DIR', 'DB_MIGRATIONS_DIR', 'DATABASE_URL', 'NODE_ENV'] as const
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.OPENCROFT_DATA_DIR = join(workdir, 'data')
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
// No BETTER_AUTH_SECRET in a test process — Better Auth needs a secret
// configured before it will sign or verify a session at all.
process.env.NODE_ENV = 'development'

const { ensureAuth } = await import('@opencroft/auth/server')
const { scanExtensionFolders } = await import('./extension-folders')
const { hasResolvedFolders } = await import('./paths')
const bundleRoute = (await import('@/server/routes/api/ext/[extensionId]/[file]')).default
const assetsRoute = (await import('@/server/routes/api/ext/[extensionId]/assets/[...path]')).default

const extensionsRoot = join(workdir, 'data', 'extensions')

after(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await rm(workdir, { recursive: true, force: true })
})

async function signUp(email: string): Promise<string> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: `Person ${email}`, email, password: 'password123456' },
    asResponse: true,
  })
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'sign-up must return a session cookie')
  return cookie
}

const cookie = await signUp('member@example.test')

/** An extension folder that is already built: a manifest, a client bundle and one asset. */
async function plantFolder(folder: string, marker: string, manifest: Record<string, unknown> = {}): Promise<void> {
  const dir = join(extensionsRoot, folder)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'extension.json'), JSON.stringify({ name: folder, version: '1.0.0', ...manifest }))
  await writeFile(join(dir, 'dist', 'client.js'), `export default '${marker}'\n`)
  await writeFile(join(dir, 'assets', 'note.json'), JSON.stringify({ from: marker }))
}

// A folder for every id shape the check must refuse, so that a route which
// skipped the check would find something to serve and say so.
const REFUSED = ['widgets', 'acme.widgets.extra', 'ACME.widgets', 'acme_widgets.x', 'local/widgets', 'acme.']

await plantFolder('acme.widgets', 'REGISTRY-BUILD')
await plantFolder('acme.other', 'OTHER-BUILD')
for (const id of REFUSED) {
  await plantFolder(id, `REFUSED-${id}`)
}

type Handler = (event: never) => Promise<Response>

function call(handler: unknown, url: string, params: Record<string, string>): Promise<Response> {
  const request = new Request(`http://localhost:9999${url}`, { headers: { cookie } })
  return (handler as Handler)({ req: request, context: { params } } as never)
}

const bundle = (extensionId: string) =>
  call(bundleRoute, `/api/ext/${extensionId}/client.js`, { extensionId, file: 'client.js' })
const asset = (extensionId: string) =>
  call(assetsRoute, `/api/ext/${extensionId}/assets/note.json`, { extensionId, path: 'note.json' })

test('CONTROL: nothing has scanned the folders yet, so the first request has to', () => {
  assert.equal(hasResolvedFolders(), false)
})

test('an extension id serves the local folder that stands in for it, on the first request of the process', async () => {
  // A development copy of acme.widgets, in a folder of its own name.
  await plantFolder('local.widgets-dev', 'LOCAL-BUILD', { id: 'acme.widgets' })

  const response = await bundle('acme.widgets')

  assert.equal(response.status, 200)
  assert.equal(await response.text(), "export default 'LOCAL-BUILD'\n")
  assert.equal(response.headers.get('content-type'), 'application/javascript; charset=utf-8')
  assert.equal(hasResolvedFolders(), true)
})

test('the assets route resolves the id the same way', async () => {
  const response = await asset('acme.widgets')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { from: 'LOCAL-BUILD' })
})

test('an id nothing stands in for serves the folder of that name', async () => {
  const response = await bundle('acme.other')

  assert.equal(await response.text(), "export default 'OTHER-BUILD'\n")
  assert.deepEqual(await (await asset('acme.other')).json(), { from: 'OTHER-BUILD' })
})

test('removing the local copy brings the registry folder back into effect', async () => {
  await rm(join(extensionsRoot, 'local.widgets-dev'), { recursive: true, force: true })
  await scanExtensionFolders()

  assert.equal(await (await bundle('acme.widgets')).text(), "export default 'REGISTRY-BUILD'\n")
  assert.deepEqual(await (await asset('acme.widgets')).json(), { from: 'REGISTRY-BUILD' })
})

for (const id of REFUSED) {
  test(`a segment that is not an extension id is a 404 from both routes: ${JSON.stringify(id)}`, async () => {
    const [fromBundle, fromAssets] = await Promise.all([bundle(id), asset(id)])

    assert.equal(fromBundle.status, 404)
    assert.equal(fromAssets.status, 404)
    assert.ok(!(await fromBundle.text()).includes('REFUSED-'), 'the folder named by the segment was served')
  })
}

test('a request without a session is refused', async () => {
  const request = new Request('http://localhost:9999/api/ext/acme.widgets/client.js')
  const response = await (bundleRoute as unknown as Handler)({
    req: request,
    context: { params: { extensionId: 'acme.widgets', file: 'client.js' } },
  } as never)

  assert.equal(response.status, 401)
})
