// The template is the shape every new extension starts from, and nothing
// compiled it. It drifted once already: it handed out the untyped spelling of
// the client surface long after the typed one existed, and no instrument could
// say so, because a template is a string until somebody builds it.
//
// So this builds it, through the real compiler rather than a stand-in. The
// second test is the narrower one and the reason this file exists: the
// specifier the template teaches is itself an assertion, not a detail.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { extensionTemplate } from '@/app/_authed/(extension-editor)/_templates/template'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-template-'))
process.env.OPENCROFT_LOCAL_EXTENSIONS = root

// Imported after the environment is set: the compiler reads the extensions
// root when the module loads, so a static import would bind the real one.
const { buildExtension } = await import('@/app/_authed/(extension-runtime)/_server/compiler')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('the extension a new project starts from compiles', async () => {
  const slug = 'probe-extension'
  const files = extensionTemplate(slug)
  const dir = path.join(root, slug)

  for (const [relPath, contents] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(relPath)), { recursive: true })
    await fs.writeFile(path.join(dir, relPath), contents)
  }

  const manifest = JSON.parse(files['extension.json']) as ExtensionManifest
  const result = await buildExtension(`local/${slug}`, manifest)

  // The errors go into the message rather than a bare `ok`: a template that
  // stops compiling is read by whoever changed the client surface, and the
  // reason is the only part of this that helps them.
  assert.ok(result.success, JSON.stringify(result.errors))
})

test('the template hands out the spelling that carries type declarations', () => {
  const client = extensionTemplate('probe-extension')['src/client.tsx']

  assert.match(client, /from '@opencroft\/client'/)
  // Not merely "the new one is present". Both spellings resolve to shims over
  // the same host object, so a template importing both would compile and read
  // as correct while still teaching the untyped one to every extension made
  // from it. Only one of them has declarations behind it, so only one may
  // appear here.
  assert.doesNotMatch(client, /@ext\/host/)
})
