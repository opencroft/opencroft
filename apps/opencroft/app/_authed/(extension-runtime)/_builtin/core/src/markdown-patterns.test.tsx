import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { Markdown } from 'agent-chat/components/markdown'
import { findReferences, installMarkdownReferences } from 'agent-chat/components/markdown-references'
import { renderToStaticMarkup } from 'react-dom/server'

import { sameOriginLinkPattern, TERMINAL_TARGET_PATTERN } from './markdown-patterns'

const ORIGIN = 'https://opencroft.example.test'

const RECOGNISERS = [
  { kind: 'core.terminal', match: 'text' as const, pattern: TERMINAL_TARGET_PATTERN },
  { kind: 'core.link', match: 'url' as const, pattern: sameOriginLinkPattern(ORIGIN) },
]

const claimed: string[] = []

function install() {
  installMarkdownReferences({
    recognisers: RECOGNISERS,
    render: (reference) => {
      claimed.push(`${reference.kind} ${reference.id}`)
      return <b>{reference.id}</b>
    },
  })
}

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

afterEach(() => {
  installMarkdownReferences(null)
  claimed.length = 0
})

const terminals = (text: string) => findReferences(text, RECOGNISERS).map((match) => match.id)

test('terminal targets in their real shapes are recognised', () => {
  assert.deepEqual(terminals('on localhost_ab12/terminal now'), ['localhost_ab12/terminal'])
  assert.deepEqual(terminals('application_tznv9pp1/terminal.'), ['application_tznv9pp1/terminal'])
  assert.deepEqual(terminals('(myspace.git/worktree-terminal-myrepo-my--task)'), [
    'myspace.git/worktree-terminal-myrepo-my--task',
  ])
  assert.deepEqual(terminals('router_x1/route-db, docker_k2/container-terminal'), [
    'router_x1/route-db',
    'docker_k2/container-terminal',
  ])
})

// Ordinary prose and code-adjacent text that has to stay text: file paths,
// URL paths, and identifiers that look like keys.
const FALSE_POSITIVES = [
  'Edit components/terminal and app/route-handler, not lib/terminal-utils.',
  'The file ./src/localhost_ab12/terminal is a path.',
  'See /home/me/myspace.git/terminal and ../app.git/terminal.',
  'A deeper path localhost_ab12/terminal/logs stays a path.',
  'x.localhost_ab12/terminal and -localhost_ab12/terminal are not starts.',
  'Fetch https://example.com/terminal and www.example.com/route-1 elsewhere.',
  'Visit https://example.com/localhost_ab12/terminal.',
  'UTF-8, SHA-256, GPT-4 and ISO-8601.',
  `A labelled [link](${ORIGIN}/space/x) keeps its label.`,
  'An external bare link https://elsewhere.test/space/x stays a link.',
  '`localhost_ab12/terminal` in code.',
  '```\nlocalhost_ab12/terminal\n```',
]

test('the false-positive fixtures render byte-identical with the core patterns installed', () => {
  const before = FALSE_POSITIVES.map(render)
  install()
  assert.deepEqual(FALSE_POSITIVES.map(render), before)
  assert.deepEqual(claimed, [])
})

test('a bare link into this origin is claimed; the origin inside a longer host is not', () => {
  install()
  render(`Open ${ORIGIN}/space/demo/app/tasks/task/DEMO-1 or ${ORIGIN}.evil.test/x`)
  assert.deepEqual(claimed, [`core.link ${ORIGIN}/space/demo/app/tasks/task/DEMO-1`])
})
