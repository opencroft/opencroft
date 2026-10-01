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
import { buildExtension } from '@/app/_authed/(extension-runtime)/_server/compiler'
import { extensionsRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-template-'))
const savedDataDir = process.env.OPENCROFT_DATA_DIR
process.env.OPENCROFT_DATA_DIR = scratch

after(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

test('the extension a new project starts from compiles', async () => {
  const slug = 'probe-extension'
  const files = extensionTemplate(slug)
  const folder = `local.${slug}`
  const dir = path.join(extensionsRoot(), folder)

  for (const [relPath, contents] of Object.entries(files)) {
    await fs.mkdir(path.join(dir, path.dirname(relPath)), { recursive: true })
    await fs.writeFile(path.join(dir, relPath), contents)
  }

  // Read back from the folder rather than from `files`: what is built is what
  // a person would open in the editor.
  const declared = JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf-8')) as ExtensionManifest
  const result = await buildExtension(folder, { ...declared, id: folder })

  // The errors go into the message rather than a bare `ok`: a template that
  // stops compiling is read by whoever changed the client surface, and the
  // reason is the only part of this that helps them.
  assert.ok(result.success, JSON.stringify(result.errors))
})

test('the template names no extension id: the folder it is created in is the id', () => {
  const files = extensionTemplate('probe-extension')

  assert.equal('id' in JSON.parse(files['extension.json']), false)
  // The client declares its name and nothing that identifies it; the loader
  // files it under the id the runtime resolved for its folder.
  assert.match(files['src/client.tsx'], /manifest: \{ name: 'Probe Extension' \}/)
  assert.doesNotMatch(files['src/client.tsx'], /local[./]probe-extension/)
})

test('the template hands out the spelling that carries type declarations', () => {
  const files = extensionTemplate('probe-extension')

  assert.match(files['src/client.tsx'], /from '@opencroft\/client'/)

  // Not merely "the new one is present". Every spelling resolves to a shim over
  // the same host object, so a template importing two of them would compile and
  // read as correct while still teaching an untyped one to every extension made
  // from it. There are TWO untyped ones, not one -- the host surface and the ui
  // surface -- and both are named below, because a test that forbids one of a
  // pair reads as a rule about the pair and is not.
  //
  // Over every file the template emits rather than the client one alone: the
  // untyped host spelling is resolved on the server side too, so a template
  // that reached for it there would teach the same thing from a file this
  // assertion was not looking at.
  const emitted = Object.values(files).join('\n')
  assert.doesNotMatch(emitted, /@ext\/host/)
  assert.doesNotMatch(emitted, /@ext\/ui/)
})
