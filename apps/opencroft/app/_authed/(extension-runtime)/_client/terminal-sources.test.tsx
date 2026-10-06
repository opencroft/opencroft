// How a router's routes read once they reach Terminal List. The routes are
// grouped by owner, so a group of one can be one terminal of an owner that has
// several; its row has to keep saying which.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { TerminalList } from 'ui/nodes/terminal-list'

import { describeGraphRef, type GraphRefDescription } from '@/app/_authed/(extension-runtime)/_client/graph-refs'
import { listedTargets, listSource, targetSources } from '@/app/_authed/(extension-runtime)/_client/terminal-sources'
import type { GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'

const dockerHost: GraphRefDescription = {
  kind: 'node',
  name: 'web',
  icon: 'Container',
  typeName: 'Docker host',
  spaceSlug: 'default',
}

const laptop: GraphRefDescription = {
  kind: 'node',
  name: 'My laptop',
  icon: 'Laptop',
  typeName: 'Localhost',
  spaceSlug: 'default',
}

const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]*>/g, '|')

function rowsOf(sources: Parameters<typeof TerminalList>[0]['sources']): string {
  return textOf(renderToStaticMarkup(<TerminalList sources={sources} searchable={false} />))
}

test('one route to a container of a docker host says which container', () => {
  const text = rowsOf([listSource('web', dockerHost, [{ target: 'web/web-1', name: 'web-1' }], {})])
  assert.match(text, /web-1 · web/)
})

test("one route to a node's only terminal is named after the node alone", () => {
  const text = rowsOf([listSource('local', laptop, [{ target: 'local/terminal', name: '' }], {})])
  assert.match(text, /\|My laptop\|/)
  assert.doesNotMatch(text, /Terminal · My laptop/)
})

test('several routes to one owner sit under its heading by their own names', () => {
  const text = rowsOf([
    listSource(
      'web',
      dockerHost,
      [
        { target: 'web/web-1', name: 'web-1' },
        { target: 'web/web-2', name: 'web-2' },
      ],
      {},
    ),
  ])
  assert.match(text, /\|web-1\|/)
  assert.match(text, /\|web-2\|/)
  assert.doesNotMatch(text, /web-1 · web/)
})

// A worktree handle's id escapes its dashes; only the App can say which
// worktree it is, and the server passes that on with the description.
const gitApp: GraphRefInfo = {
  id: 'space-1.code',
  kind: 'app',
  type: 'app:acme.git.git',
  name: 'Code',
  spaceSlug: 'space-1',
  handleLabels: { 'worktree-terminal-scratch-login--form': 'scratch · login-form' },
}

test('one route to a worktree is named the way its App names it', () => {
  const handleId = 'worktree-terminal-scratch-login--form'
  const owner = describeGraphRef(gitApp, handleId)
  const route = { target: `${gitApp.id}/${handleId}`, name: owner.detail ?? '' }
  const text = rowsOf([listSource(gitApp.id, owner, [route], {})])
  assert.match(text, /scratch · login-form · Code/)
  assert.doesNotMatch(text, /login--form/)
})

test('a handle its App does not name falls back to its id', () => {
  assert.equal(describeGraphRef(gitApp, 'worktree-terminal-other').detail, 'worktree-terminal-other')
  assert.equal(describeGraphRef(gitApp, 'terminal').detail, undefined)
})

// A stopped container's route still carries the exec context saved when it
// was added; what tells it is gone is that its docker host no longer lists it.
const web2 = { target: 'web/web-2' }
const described = { 'web/web-2': { ...dockerHost, detail: 'web-2' } }
const docker = (loading: boolean) => [
  listSource('web', dockerHost, [{ target: 'web/web-1', name: 'web-1' }], { loading }),
]

test('a route no source lists any more is unavailable once every source has answered', () => {
  const text = rowsOf(targetSources([web2], described, listedTargets(docker(false), false)))
  assert.match(text, /web-2 · web\|+unavailable/)
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
  const listed = listedTargets([listSource('web', dockerHost, [{ target: 'web/web-2', name: 'web-2' }], {})], false)
  assert.doesNotMatch(rowsOf(targetSources([web2], described, listed)), /unavailable/)
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
    listSource('build', server, [{ target: 'build/terminal', name: '' }], {}),
    listSource('qa-web', application, [{ target: 'qa-web/web-1', name: 'web-1' }], {}),
  ])
  assert.match(nodes, /color:oklch\(0\.7 0\.18 300\)/)
  assert.match(nodes, /color:var\(--primary\)/)
  const app = markupOf([
    listSource(gitApp.id, describeGraphRef(gitApp), [{ target: `${gitApp.id}/a`, name: 'scratch · main' }], {}),
  ])
  assert.doesNotMatch(app, /color:/)
})

test('a heading carries its kind colour too, and no row or heading says node or app', () => {
  const html = markupOf([
    listSource(
      'qa-web',
      application,
      [
        { target: 'qa-web/web-1', name: 'web-1' },
        { target: 'qa-web/web-2', name: 'web-2' },
      ],
      {},
    ),
    listSource(gitApp.id, describeGraphRef(gitApp), [{ target: `${gitApp.id}/a`, name: 'scratch · main' }], {}),
  ])
  assert.match(html, /color:var\(--primary\)/)
  assert.doesNotMatch(textOf(html), /\|(node|app)\|/)
})

test('a terminal that is not running loses its kind colour', () => {
  const html = markupOf([listSource('build', server, [{ target: 'build/terminal', name: '', unavailable: true }], {})])
  assert.match(textOf(html), /unavailable/)
  assert.doesNotMatch(html, /color:/)
})
