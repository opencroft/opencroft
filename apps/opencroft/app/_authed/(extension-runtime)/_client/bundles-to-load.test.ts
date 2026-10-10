// A page loads only the extensions whose bundles declare what it shows. An
// extension whose declaration the server could not read is loaded by every
// surface, so a doubt about a bundle never hides what it provides.
import assert from 'node:assert/strict'
import test from 'node:test'

import { clientsProviding, clientsWithSettingsPages } from '@/app/_authed/(extension-runtime)/_client/bundles-to-load'

const ids = (clients: { id: string }[]) => clients.map((client) => client.id)

test('an extension whose points are not known is loaded for any point', () => {
  const clients = [{ id: 'ext-a', providedPoints: null }]

  assert.deepEqual(ids(clientsProviding(clients, 'right-sidebar-panels')), ['ext-a'])
  assert.deepEqual(ids(clientsProviding(clients, 'markdownResolvers')), ['ext-a'])
})

test('an extension that lists the point is loaded for it', () => {
  const clients = [{ id: 'ext-a', providedPoints: ['apps', 'right-sidebar-panels'] }]

  assert.deepEqual(ids(clientsProviding(clients, 'right-sidebar-panels')), ['ext-a'])
})

test('an extension that does not list the point is not loaded for it, an empty list included', () => {
  const clients = [
    { id: 'ext-a', providedPoints: ['apps'] },
    { id: 'ext-b', providedPoints: [] },
  ]

  assert.deepEqual(clientsProviding(clients, 'right-sidebar-panels'), [])
})

test('the selection for a point keeps the listing’s order', () => {
  const clients = [
    { id: 'ext-c', providedPoints: null },
    { id: 'ext-a', providedPoints: ['apps'] },
    { id: 'ext-b', providedPoints: ['right-sidebar-panels'] },
    { id: 'ext-d', providedPoints: ['apps'] },
  ]

  assert.deepEqual(ids(clientsProviding(clients, 'apps')), ['ext-c', 'ext-a', 'ext-d'])
})

test('the settings menu loads the extensions with settings pages and those not known, in listing order', () => {
  const clients = [
    { id: 'ext-c', hasSettingsPages: null },
    { id: 'ext-a', hasSettingsPages: false },
    { id: 'ext-b', hasSettingsPages: true },
  ]

  assert.deepEqual(ids(clientsWithSettingsPages(clients)), ['ext-c', 'ext-b'])
})

test('the settings menu loads nothing when no extension has settings pages', () => {
  const clients = [
    { id: 'ext-a', hasSettingsPages: false },
    { id: 'ext-b', hasSettingsPages: false },
  ]

  assert.deepEqual(clientsWithSettingsPages(clients), [])
})
