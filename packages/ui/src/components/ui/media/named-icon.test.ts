import assert from 'node:assert/strict'
import test from 'node:test'

import { Box } from 'lucide-react'
import * as lucide from 'lucide-react'
import { dynamicIconImports } from 'lucide-react/dynamic.mjs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { iconComponent, iconExportNames, iconKey, NamedIcon, preloadIcons } from './named-icon'

// What `lucide-react` exports besides icons, `default` being what Node adds to
// a CommonJS module imported as a namespace.
const NOT_ICONS = new Set(['icons', 'createLucideIcon', 'Icon', 'LucideProvider', 'useLucideContext', 'default'])

test('every icon export of lucide-react names the module that holds that very icon', async () => {
  const exportNames = Object.keys(lucide).filter((name) => !NOT_ICONS.has(name))
  assert.ok(exportNames.length > 1000, `expected the full icon set, got ${exportNames.length} exports`)
  // Compared by the icon's own name rather than by identity: under Node the
  // package's main entry is its CommonJS build while the per-icon modules are
  // ES modules, so the same icon is two objects here.
  const wrong: string[] = []
  for (const name of exportNames) {
    const key = iconKey(name)
    const module = key ? await dynamicIconImports[key]() : undefined
    const expected = (lucide as Record<string, { displayName?: string }>)[name].displayName
    if (expected === undefined || module?.default.displayName !== expected) {
      wrong.push(`${name} -> ${key ?? 'nothing'}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('the export names offered are exactly the icon exports of lucide-react', () => {
  const exported = Object.keys(lucide)
    .filter((name) => !NOT_ICONS.has(name))
    .sort()
  assert.deepEqual([...iconExportNames()].sort(), exported)
})

test('a kebab-case name is its own key', () => {
  assert.equal(iconKey('arrow-right'), 'arrow-right')
  assert.equal(iconKey('grid-2x2'), 'grid-2x2')
})

test('a name Lucide does not have, or an object property name, is no icon', () => {
  for (const name of ['no-such-icon', 'NoSuchIcon', 'constructor', 'toString', '__proto__', '', 'Icon', 'Lucide']) {
    assert.equal(iconKey(name), undefined, name)
  }
})

test('a preloaded icon draws on the first render', async () => {
  await preloadIcons(['Rocket'])
  const html = renderToString(createElement(NamedIcon, { name: 'rocket', className: 'size-4' }))
  assert.match(html, /<svg[^>]*class="lucide lucide-rocket size-4"/)
  assert.match(html, /<path/)
})

test('an icon still loading holds its place with a blank icon of the same class', () => {
  const html = renderToString(createElement(NamedIcon, { name: 'anchor', className: 'size-4' }))
  assert.match(html, /<svg[^>]*class="lucide size-4"/)
  assert.doesNotMatch(html, /<path|<circle|<line/)
})

test('a name Lucide does not have draws the fallback', () => {
  const html = renderToString(createElement(NamedIcon, { name: 'no-such-icon', fallback: Box }))
  assert.match(html, /lucide-box/)
})

test('one name and fallback give back one component', () => {
  assert.equal(iconComponent('Rocket', Box), iconComponent('Rocket', Box))
  assert.notEqual(iconComponent('Rocket', Box), iconComponent('Rocket'))
})
