import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import { installedFolders, type RegistryHit, searchResults } from './registry-search'

function hit(registryName: string, id: string, repository: string, description?: string): RegistryHit {
  return { registryName, id, name: id, repository, description }
}

function installed(folder: string, sourceUrl?: string): ExtensionIndexEntry {
  return { folder, id: folder, name: folder, version: '1.0.0', kind: 'installed', active: true, sourceUrl }
}

test('a result whose repository is installed is marked installed, and the folder it opens is the install', () => {
  const folders = installedFolders([
    installed('acme.kanban', 'https://git.example.com/acme/kanban.git'),
    installed('acme.notes'),
  ])
  const results = searchResults(
    [
      hit('Acme', 'acme.kanban', 'https://git.example.com/acme/kanban.git', 'Boards'),
      hit('Acme', 'acme.charts', 'https://git.example.com/acme/charts.git'),
    ],
    folders,
    null,
  )
  assert.deepEqual(results, [
    { id: 'Acme/acme.kanban', name: 'acme.kanban', description: 'Boards', source: 'Acme', state: 'installed' },
    { id: 'Acme/acme.charts', name: 'acme.charts', description: undefined, source: 'Acme', state: 'available' },
  ])
  assert.equal(folders.get('https://git.example.com/acme/kanban.git'), 'acme.kanban')
  assert.equal(folders.size, 1)
})

test('one extension id listed by two registries is two results, and only the one being installed says so', () => {
  const results = searchResults(
    [
      hit('Acme', 'acme.kanban', 'https://git.example.com/acme/kanban.git'),
      hit('Community', 'acme.kanban', 'https://git.example.com/fork/kanban.git'),
    ],
    new Map(),
    'Community/acme.kanban',
  )
  assert.deepEqual(
    results.map((result) => [result.id, result.source, result.state]),
    [
      ['Acme/acme.kanban', 'Acme', 'available'],
      ['Community/acme.kanban', 'Community', 'installing'],
    ],
  )
})
