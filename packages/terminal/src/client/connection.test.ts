// `connectionFromContext` turns what a terminal-context handle carries into what the Terminal
// component opens. A docker-exec context is the case with logic: which shell, as whom and where.
import assert from 'node:assert/strict'
import test from 'node:test'

import { connectionFromContext } from './connection'

const FALLBACK = 'command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l'

test('no context is no connection', () => {
  assert.equal(connectionFromContext(undefined), null)
})

test('a local, wsl or ssh context is opened as it is', () => {
  assert.deepEqual(connectionFromContext({ type: 'local' }), { type: 'local', config: {} })
  assert.deepEqual(connectionFromContext({ type: 'wsl', distro: 'Ubuntu' }), {
    type: 'wsl',
    config: { distro: 'Ubuntu' },
  })
  assert.deepEqual(connectionFromContext({ type: 'ssh', host: 'h', username: 'u' }), {
    type: 'ssh',
    config: { host: 'h', username: 'u' },
  })
})

test('a docker-exec context with no shell runs bash where the image has it and sh where it does not', () => {
  const connection = connectionFromContext({ type: 'docker-exec', via: { type: 'local' }, containerId: 'c1' })
  assert.deepEqual(connection, {
    type: 'local',
    config: { command: 'docker', args: ['exec', '-it', 'c1', 'sh', '-lc', FALLBACK] },
  })
})

test('a docker-exec context opens its shell, as its user, in its directory, on its docker context', () => {
  const connection = connectionFromContext({
    type: 'docker-exec',
    via: { type: 'local' },
    contextName: 'remote',
    containerId: 'c1',
    cwd: '/srv/app',
    user: 'node',
    shell: '/bin/zsh',
  })
  assert.deepEqual(connection, {
    type: 'local',
    config: {
      command: 'docker',
      args: [
        '--context',
        'remote',
        'exec',
        '-w',
        '/srv/app',
        '-u',
        'node',
        '-it',
        'c1',
        'sh',
        '-lc',
        'exec /bin/zsh -l',
      ],
    },
  })
})

test('a docker-exec context over wsl keeps the distro and passes the arguments as they are', () => {
  const connection = connectionFromContext({
    type: 'docker-exec',
    via: { type: 'wsl', distro: 'Ubuntu' },
    containerId: 'c1',
  })
  assert.deepEqual(connection, {
    type: 'wsl',
    config: { distro: 'Ubuntu', command: 'docker', args: ['exec', '-it', 'c1', 'sh', '-lc', FALLBACK] },
  })
})

test('a docker-exec context over ssh is one command line, with every argument that needs it quoted', () => {
  const connection = connectionFromContext({
    type: 'docker-exec',
    via: { type: 'ssh', host: 'h', username: 'u' },
    containerId: 'c1',
    cwd: '/srv/my app',
  })
  assert.deepEqual(connection, {
    type: 'ssh',
    config: {
      host: 'h',
      username: 'u',
      command: `docker exec -w '/srv/my app' -it c1 sh -lc '${FALLBACK}'`,
    },
  })
})
