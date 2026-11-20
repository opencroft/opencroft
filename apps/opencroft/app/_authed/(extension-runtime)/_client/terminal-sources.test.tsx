// How terminals read once they reach Terminal List and Terminal Path: each
// under the one name the host gave it, grouped by space and then by the graph
// or App it sits in, and a chosen one shown with where it is.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { TerminalList, TerminalPath, terminalPathForm, terminalPathSegments } from 'ui/nodes/terminal-list'

import { describeGraphRef, type GraphRefDescription } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import {
  listedTargets,
  listSource,
  pickerSources,
  placeOf,
  routedName,
  targetSources,
} from '@/app/_authed/(extension-runtime)/_client/terminal-sources'
import type { GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'

const mainGraph = { address: 'default.main', name: 'Main' }
const labGraph = { address: 'default.lab', name: 'Lab' }

const dockerHost: GraphRefDescription = {
  kind: 'node',
  name: 'web',
  title: 'web',
  icon: 'Container',
  typeName: 'Docker host',
  spaceSlug: 'default',
  spaceName: 'Default',
  graph: mainGraph,
}

const laptop: GraphRefDescription = {
  kind: 'node',
  name: 'My laptop',
  title: 'My laptop',
  icon: 'Laptop',
  typeName: 'Localhost',
  spaceSlug: 'default',
  spaceName: 'Default',
  graph: labGraph,
}

const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '|')

function rowsOf(sources: Parameters<typeof TerminalList>[0]['sources']): string {
  return textOf(renderToStaticMarkup(<TerminalList sources={sources} searchable={false} />))
}

test('every row reads as the name it was given, with nothing added from its owner', () => {
  const text = rowsOf([
    listSource('web', dockerHost, [
      { target: 'web/web-1', name: 'web · web-1' },
      { target: 'web/web-2', name: 'web · web-2' },
    ]),
    listSource('local', laptop, [{ target: 'local/terminal', name: 'My laptop' }]),
  ])
  assert.match(text, /\|web · web-1\|/)
  assert.match(text, /\|web · web-2\|/)
  assert.match(text, /\|My laptop\|/)
  assert.doesNotMatch(text, /web-1 · web\b/)
  assert.doesNotMatch(text, /My laptop · My laptop/)
})

test('terminals are grouped by the graph their node is on, the graphs in the order they come', () => {
  const html = renderToStaticMarkup(
    <TerminalList
      searchable={false}
      sources={[
        listSource('web', dockerHost, [{ target: 'web/web-1', name: 'web · web-1' }]),
        listSource('local', laptop, [{ target: 'local/terminal', name: 'My laptop' }]),
        listSource('db', { ...dockerHost, name: 'db', title: 'db' }, [{ target: 'db/pg', name: 'db · pg' }]),
      ]}
    />,
  )
  const text = textOf(html)
  // Main holds web and db, though db came after Lab's laptop.
  assert.match(text, /Main\|+.*web · web-1\|+.*db · pg\|+.*Lab\|+.*My laptop/)
  // One space: no space heading.
  assert.doesNotMatch(text, /\|Default\|/)
})

test('terminals of several spaces are sectioned by space, each space by its own graphs', () => {
  const other: GraphRefDescription = {
    ...laptop,
    spaceSlug: 'lab-space',
    spaceName: 'Lab space',
    graph: { address: 'lab-space.default', name: 'Default graph' },
  }
  const text = rowsOf([
    listSource('web', dockerHost, [{ target: 'web/web-1', name: 'web · web-1' }]),
    listSource('far', other, [{ target: 'far/terminal', name: 'My laptop' }]),
  ])
  assert.match(text, /Default\|+.*Main\|+.*web · web-1\|+.*Lab space\|+.*Default graph\|+.*My laptop/)
})

// A worktree handle's id escapes its dashes; only the App can say which
// worktree it is, and the server names the terminal with it.
const gitApp: GraphRefInfo = {
  id: 'space-1.code',
  kind: 'app',
  type: 'app:acme.git.git',
  name: 'Code',
  spaceSlug: 'space-1',
  spaceName: 'Space one',
  address: 'space-1.code',
  detail: 'scratch · login-form',
  title: 'scratch · login-form',
}

test("an App's terminals are grouped under the App, each by the App's name for it", () => {
  const owner = describeGraphRef(gitApp)
  const text = rowsOf([listSource(gitApp.id, owner, [{ target: `${gitApp.id}/a`, name: owner.title }])])
  assert.match(text, /Code\|+.*scratch · login-form/)
  assert.doesNotMatch(text, /login--form/)
  assert.doesNotMatch(text, /Code · scratch/)
})

test("a node's place is its space and its graph; an App's, its space and itself", () => {
  assert.deepEqual(placeOf(dockerHost, 'web'), {
    space: { id: 'default', name: 'Default' },
    app: { id: 'default.main', name: 'Main' },
  })
  assert.deepEqual(placeOf(describeGraphRef(gitApp), gitApp.id), {
    space: { id: 'space-1', name: 'Space one' },
    app: { id: 'space-1.code', name: 'Code' },
  })
  assert.deepEqual(placeOf(null, 'gone'), {})
})

test("a router's route is named by the terminal it reaches, the way the host named it", () => {
  const handleId = 'worktree-terminal-scratch-login--form'
  assert.equal(routedName({ target: `${gitApp.id}/${handleId}`, ref: gitApp }), 'scratch · login-form')
  const { detail: _detail, title: _title, ...plainApp } = gitApp
  assert.equal(routedName({ target: `${gitApp.id}/terminal`, ref: plainApp }), 'Code')
})

const localInfo: GraphRefInfo = {
  id: 'local',
  kind: 'node',
  type: 'acme.machines.localhost',
  name: 'My laptop',
  spaceSlug: 'default',
  spaceName: 'Default',
  graph: labGraph,
}
const routerInfo: GraphRefInfo = { ...localInfo, id: 'router', type: 'acme.machines.terminal-router', name: 'Router' }
const pickerState = {
  infos: [
    { ref: localInfo, targets: [{ target: 'local/terminal', handleId: 'terminal', title: 'My laptop' }] },
    {
      ref: routerInfo,
      targets: [
        { target: 'router/route-r1', handleId: 'route-r1', routed: { target: 'local/terminal', ref: localInfo } },
      ],
    },
    { ref: { ...localInfo, id: 'web', name: 'web' }, targets: null },
  ],
  expanded: {},
  pending: ['web'],
}

test("a picker draws every source, a router's route named by the terminal it reaches", () => {
  const sources = pickerSources(pickerState)
  assert.deepEqual(
    sources.map((source) => [source.id, source.terminals.map((terminal) => terminal.name), source.loading]),
    [
      ['local', ['My laptop'], false],
      ['router', ['My laptop'], false],
      ['web', [], true],
    ],
  )
})

test('a picker leaves out each source its exclude answers true for, told the source id and type', () => {
  const asked: Array<{ id: string; type: string }> = []
  const sources = pickerSources(pickerState, (source) => {
    asked.push(source)
    return source.type === 'acme.machines.terminal-router'
  })
  assert.deepEqual(
    sources.map((source) => source.id),
    ['local', 'web'],
  )
  assert.deepEqual(asked, [
    { id: 'local', type: 'acme.machines.localhost' },
    { id: 'router', type: 'acme.machines.terminal-router' },
    { id: 'web', type: 'acme.machines.localhost' },
  ])
})

test('a route whose terminal nothing answers to is named by its target', () => {
  assert.equal(routedName({ target: 'gone/terminal', ref: null }), 'gone/terminal')
})

// A stopped container's route still carries the exec context saved when it
// was added; what tells it is gone is that its docker host no longer lists it.
const web2 = { target: 'web/web-2' }
const described = { 'web/web-2': { ...dockerHost, detail: 'web-2', title: 'web · web-2' } }
const docker = (loading: boolean) => [
  listSource('web', dockerHost, [{ target: 'web/web-1', name: 'web · web-1' }], { loading }),
]

test('a route no source lists any more is unavailable once every source has answered', () => {
  const text = rowsOf(targetSources([web2], described, listedTargets(docker(false), false)))
  assert.match(text, /web · web-2\|+unavailable/)
})

test('a route is not called unavailable while a source is still being asked', () => {
  assert.equal(listedTargets(docker(true), false), null)
  assert.equal(listedTargets(docker(false), true), null)
  assert.doesNotMatch(rowsOf(targetSources([web2], described, null)), /unavailable/)
})

test('a route its host says does not resolve stays unavailable before the sources answer', () => {
  const text = rowsOf(targetSources([{ ...web2, unavailable: true }], described, null))
  assert.match(text, /unavailable/)
})

test('a route its source lists is available', () => {
  const listed = listedTargets([listSource('web', dockerHost, [{ target: 'web/web-2', name: 'web · web-2' }])], false)
  assert.doesNotMatch(rowsOf(targetSources([web2], described, listed)), /unavailable/)
})

test('a route nothing describes is named by its target', () => {
  assert.match(rowsOf(targetSources([{ target: 'gone/terminal' }], {}, null)), /\|gone\/terminal\|/)
})

// An Application node and an App share an icon; the colour is what tells them
// apart, and it is the node type's own, carried on its description.
const server: GraphRefDescription = { ...laptop, name: 'build', typeName: 'Server', accent: 'oklch(0.7 0.18 300)' }
const application: GraphRefDescription = {
  ...dockerHost,
  name: 'qa-web',
  icon: 'AppWindow',
  typeName: 'Application',
  accent: 'var(--primary)',
}

function markupOf(sources: Parameters<typeof TerminalList>[0]['sources']): string {
  return renderToStaticMarkup(<TerminalList sources={sources} searchable={false} />)
}

test("a node's icon is drawn in its kind's colour, an App's in the text colour", () => {
  const nodes = markupOf([
    listSource('build', server, [{ target: 'build/terminal', name: 'build' }]),
    listSource('qa-web', application, [{ target: 'qa-web/web-1', name: 'qa-web · web-1' }]),
  ])
  assert.match(nodes, /color:oklch\(0\.7 0\.18 300\)/)
  assert.match(nodes, /color:var\(--primary\)/)
  const app = markupOf([
    listSource(gitApp.id, describeGraphRef(gitApp), [{ target: `${gitApp.id}/a`, name: 'scratch · main' }]),
  ])
  assert.doesNotMatch(app, /color:/)
})

test('no row or heading says node or app', () => {
  const html = markupOf([
    listSource('qa-web', application, [
      { target: 'qa-web/web-1', name: 'qa-web · web-1' },
      { target: 'qa-web/web-2', name: 'qa-web · web-2' },
    ]),
    listSource(gitApp.id, describeGraphRef(gitApp), [{ target: `${gitApp.id}/a`, name: 'scratch · main' }]),
  ])
  assert.doesNotMatch(textOf(html), /\|(node|app)\|/i)
})

test('a terminal that is not running loses its kind colour', () => {
  const html = markupOf([listSource('build', server, [{ target: 'build/terminal', name: 'build', unavailable: true }])])
  assert.match(textOf(html), /unavailable/)
  assert.doesNotMatch(html, /color:/)
})

const texts = (segments: Array<{ text: string }>) => segments.map((segment) => segment.text)
const path = { space: 'Default', app: 'Main', name: 'web · web-1' }

test('a path has a full, a short and a bare form', () => {
  assert.deepEqual(texts(terminalPathSegments('full', path)), ['Default', 'Main', 'web · web-1'])
  assert.deepEqual(texts(terminalPathSegments('short', path)), ['Default', '…', 'web · web-1'])
  assert.deepEqual(texts(terminalPathSegments('name', path)), ['web · web-1'])
})

test('an App named like its only terminal is left out of the path rather than said twice', () => {
  const app = { space: 'Default', app: 'Notes', name: 'Notes' }
  assert.deepEqual(texts(terminalPathSegments('full', app)), ['Default', 'Notes'])
  assert.deepEqual(texts(terminalPathSegments('short', app)), ['Default', 'Notes'])
})

test('the longest form that fits is shown', () => {
  const widths = { full: 300, short: 200 }
  assert.equal(terminalPathForm(400, widths), 'full')
  assert.equal(terminalPathForm(300, widths), 'full')
  assert.equal(terminalPathForm(299, widths), 'short')
  assert.equal(terminalPathForm(200, widths), 'short')
  assert.equal(terminalPathForm(199, widths), 'name')
  assert.equal(terminalPathForm(0, widths), 'name')
})

test('a path draws all three forms: the shown one, and the two it measures unseen', () => {
  const html = renderToStaticMarkup(<TerminalPath {...path} />)
  const text = textOf(html)
  // Shown first in its full form, then the full and the short form measured.
  assert.equal(text.match(/\|Main\|/g)?.length, 2)
  assert.equal(text.match(/…/g)?.length, 1)
  assert.equal(html.match(/invisible absolute/g)?.length, 2)
  // Nothing is hidden in the full form, so there is no hover hint.
  assert.doesNotMatch(html, /title=/)
})
