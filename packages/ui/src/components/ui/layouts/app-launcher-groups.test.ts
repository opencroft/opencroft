import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { type AppLauncherApp, AppLauncherSearch, type AppLauncherSearchProps } from './app-launcher'
import { groupBySpace, groupByType, searchSpaces } from './app-launcher-groups'
import type { SelectorSpace } from './space-selector'

const app = (id: string, spaceSlug: string, label: string, type: string): AppLauncherApp => ({
  id,
  spaceSlug,
  label,
  href: `/space/${spaceSlug}/app/${id}`,
  type,
})

const spaces: SelectorSpace[] = [
  { slug: 'garden', name: 'Garden', icon: '' },
  { slug: 'kitchen', name: 'Kitchen', icon: '' },
]

const apps = [
  app('g-tasks', 'garden', 'Weeding', 'Tasks'),
  app('g-docs-b', 'garden', 'planting notes', 'Documentation'),
  app('g-docs-a', 'garden', 'Harvest log', 'Documentation'),
  app('g-graph', 'garden', 'Garden', 'Graph'),
  app('k-docs', 'kitchen', 'Recipes', 'Documentation'),
  app('k-tasks', 'kitchen', 'Shopping', 'Tasks'),
]

const summary = (groups: ReturnType<typeof groupByType>) =>
  groups.map((group) => [group.type, group.apps.map((a) => a.label)])

test('groupByType orders the types by name and the apps by name inside each, ignoring case', () => {
  assert.deepEqual(summary(groupByType(apps.filter((a) => a.spaceSlug === 'garden'))), [
    ['Documentation', ['Harvest log', 'planting notes']],
    ['Graph', ['Garden']],
    ['Tasks', ['Weeding']],
  ])
})

test('groupByType orders numbered names by their number', () => {
  const numbered = [app('b', 's', 'Notes 10', 'Docs'), app('a', 's', 'Notes 2', 'Docs')]
  assert.deepEqual(summary(groupByType(numbered)), [['Docs', ['Notes 2', 'Notes 10']]])
})

test('groupBySpace keeps the spaces in the order their first app comes', () => {
  const recent = [apps[4], apps[0], apps[5]]
  assert.deepEqual([...groupBySpace(recent).keys()], ['kitchen', 'garden'])
})

test('searchSpaces groups the matching apps of each space by type', () => {
  const found = searchSpaces(spaces, groupBySpace(apps), 'r')
  assert.deepEqual(
    found.map(({ space, spaceMatches, types }) => [space.slug, spaceMatches, summary(types)]),
    [['kitchen', false, [['Documentation', ['Recipes']]]]],
  )
})

test('searchSpaces lists a space that matches by name ahead of its matching apps', () => {
  const found = searchSpaces(spaces, groupBySpace(apps), 'garden')
  assert.deepEqual(
    found.map(({ space, spaceMatches, types }) => [space.slug, spaceMatches, summary(types)]),
    [['garden', true, [['Graph', ['Garden']]]]],
  )
})

test('searchSpaces finds apps by their type and narrows by the space name', () => {
  const found = searchSpaces(spaces, groupBySpace(apps), 'doc kitchen')
  assert.deepEqual(
    found.map(({ space, types }) => [space.slug, summary(types)]),
    [['kitchen', [['Documentation', ['Recipes']]]]],
  )
})

test('searchSpaces drops every space with nothing found', () => {
  assert.deepEqual(searchSpaces(spaces, groupBySpace(apps), 'zzz'), [])
})

const props: AppLauncherSearchProps = {
  spaces,
  apps,
  recent: [],
  pages: [],
  hrefFor: (slug) => `/space/${slug}`,
}

// The group headings and row labels of the rendered list, in document order.
function listed(markup: string): string[] {
  const list = markup.slice(markup.indexOf('cmdk-list'))
  return [
    ...list.matchAll(
      /cmdk-group-heading=""[^>]*>(?:<span[^>]*>(?:<[^>]*>)*)?([^<]+)|<span class="min-w-0 flex-1 truncate">([^<]+)/g,
    ),
  ].map((match) => (match[1] ? `# ${match[1]}` : match[2]))
}

test('a space lists its apps under type headings, by name', () => {
  const markup = renderToStaticMarkup(
    createElement(AppLauncherSearch, { ...props, opensOn: 'space', currentSlug: 'garden' }),
  )
  assert.deepEqual(listed(markup), [
    '# Documentation',
    'Harvest log',
    'planting notes',
    '# Graph',
    'Garden',
    '# Tasks',
    'Weeding',
  ])
})

test('Recent lists its spaces by last use, each with its apps under type headings, by name', () => {
  const recent = [apps[5], apps[0], apps[1], apps[4], apps[2]]
  const markup = renderToStaticMarkup(createElement(AppLauncherSearch, { ...props, recent }))
  assert.deepEqual(listed(markup), [
    '# Kitchen',
    '# Documentation',
    'Recipes',
    '# Tasks',
    'Shopping',
    '# Garden',
    '# Documentation',
    'Harvest log',
    'planting notes',
    '# Tasks',
    'Weeding',
  ])
})
