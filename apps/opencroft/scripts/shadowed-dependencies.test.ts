import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { shadowedDependencies } from './shadowed-dependencies'

const root = mkdtempSync(join(tmpdir(), 'shadowed-dependencies-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** A repository laid out as npm installs a workspace: `apps/app`, `packages/*`, and the hoisted root. */
function repository(name: string, installed: Record<string, string>): { app: string; packages: string } {
  const repo = join(root, name)
  mkdirSync(join(repo, 'apps', 'app'), { recursive: true })
  mkdirSync(join(repo, 'packages'), { recursive: true })
  for (const [path, version] of Object.entries(installed)) {
    const dir = join(repo, path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  }
  return { app: join(repo, 'apps', 'app'), packages: join(repo, 'packages') }
}

test('a package a workspace package holds at another version than the app resolves is listed', () => {
  const { app, packages } = repository('split', {
    'node_modules/marked': '14.0.0',
    'packages/chat/node_modules/marked': '17.0.6',
  })
  assert.deepEqual(shadowedDependencies(app, packages), ['marked'])
})

test('a copy at the version the app resolves is not listed, though the hoisted copy differs', () => {
  const { app, packages } = repository('same', {
    'node_modules/cn': '0.2.6',
    'apps/app/node_modules/cn': '0.4.0',
    'packages/ui/node_modules/cn': '0.4.0',
  })
  assert.deepEqual(shadowedDependencies(app, packages), [])
})

test('the app resolves its own copy before the hoisted one', () => {
  const { app, packages } = repository('nearest', {
    'node_modules/cn': '0.4.0',
    'apps/app/node_modules/cn': '0.2.6',
    'packages/ui/node_modules/cn': '0.4.0',
  })
  assert.deepEqual(shadowedDependencies(app, packages), ['cn'])
})

test('scoped packages are listed by their full name, and one the app cannot resolve at all is listed', () => {
  const { app, packages } = repository('scoped', {
    'node_modules/@scope/a': '1.0.0',
    'packages/one/node_modules/@scope/a': '2.0.0',
    'packages/two/node_modules/@scope/b': '1.0.0',
    'packages/two/node_modules/.bin/tool': '0.0.0',
  })
  assert.deepEqual(shadowedDependencies(app, packages), ['@scope/a', '@scope/b'])
})
