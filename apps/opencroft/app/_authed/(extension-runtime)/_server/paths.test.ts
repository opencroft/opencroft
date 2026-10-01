// Where an extension's files, build output and build staging live. Pure path
// arithmetic over the data dir; nothing here touches the disk.
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import {
  builtinSourceRoot,
  extDir,
  extDistDir,
  extensionsRoot,
  folderDir,
  folderDistDir,
  folderOf,
  isStagingName,
  setResolvedFolders,
  stagingName,
} from './paths'

const DATA_DIR = path.join(path.sep, 'srv', 'opencroft-data')
let savedDataDir: string | undefined

beforeEach(() => {
  savedDataDir = process.env.OPENCROFT_DATA_DIR
  process.env.OPENCROFT_DATA_DIR = DATA_DIR
})

afterEach(() => {
  if (savedDataDir === undefined) {
    delete process.env.OPENCROFT_DATA_DIR
  } else {
    process.env.OPENCROFT_DATA_DIR = savedDataDir
  }
  setResolvedFolders(new Map())
})

test('every extension folder lives under the data dir, in one root', () => {
  assert.equal(extensionsRoot(), path.join(DATA_DIR, 'extensions'))
  assert.equal(folderDir('acme.widgets'), path.join(DATA_DIR, 'extensions', 'acme.widgets'))
  assert.equal(folderDir('local.widgets'), path.join(DATA_DIR, 'extensions', 'local.widgets'))
})

test('build output is the dist/ inside the folder', () => {
  assert.equal(folderDistDir('acme.widgets'), path.join(DATA_DIR, 'extensions', 'acme.widgets', 'dist'))
})

test('a builtin keeps its sources in the app and builds into a folder of the same name under the root', () => {
  assert.equal(folderDir('builtin.core'), path.join(builtinSourceRoot(), 'core'))
  assert.equal(folderDistDir('builtin.core'), path.join(DATA_DIR, 'extensions', 'builtin.core', 'dist'))
})

test('a build stages inside dist/, under a name the sweep of stale staging recognises', () => {
  const dist = folderDistDir('local.widgets')
  const staged = stagingName(dist, 7)

  assert.equal(path.dirname(staged), dist, 'inside dist/, which extension repositories ignore')
  assert.ok(isStagingName(path.basename(staged)))
})

test('only a per-attempt staging directory counts as staging', () => {
  for (const name of ['.building', '.building-x-1', 'building-1-2', 'dist.building-1-2', 'chunk-abc', 'client.js']) {
    assert.equal(isStagingName(name), false, name)
  }
})

test('an id is its own folder until the index resolves it to another', () => {
  assert.equal(folderOf('acme.widgets'), 'acme.widgets')
  assert.equal(extDir('acme.widgets'), path.join(DATA_DIR, 'extensions', 'acme.widgets'))

  setResolvedFolders(new Map([['acme.widgets', 'local.widgets']]))

  assert.equal(folderOf('acme.widgets'), 'local.widgets')
  assert.equal(extDir('acme.widgets'), path.join(DATA_DIR, 'extensions', 'local.widgets'))
  assert.equal(extDistDir('acme.widgets'), path.join(DATA_DIR, 'extensions', 'local.widgets', 'dist'))
  assert.equal(folderOf('acme.gauges'), 'acme.gauges', 'an id nothing redirects is unaffected')
})

test('resolving replaces what an earlier resolution said', () => {
  setResolvedFolders(new Map([['acme.widgets', 'local.widgets']]))
  setResolvedFolders(new Map())

  assert.equal(folderOf('acme.widgets'), 'acme.widgets')
})
