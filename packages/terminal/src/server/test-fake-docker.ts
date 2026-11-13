// For tests only. A stand-in `docker` on PATH that runs what `docker exec … -i <container>` would
// run in the container, here, with the stdin it was given. Enough to show what reaches the inner
// command and what comes back out of it.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { TerminalContext } from '../types'

export const DOCKER_EXEC: TerminalContext = { type: 'docker-exec', containerId: 'c1' } as TerminalContext

export async function withFakeDocker(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-docker-'))
  const savedPath = process.env.PATH
  try {
    await writeFile(
      path.join(dir, 'docker'),
      '#!/bin/sh\nwhile [ "$1" != "-i" ]; do shift; done\nshift 2\nexec "$@"\n',
      { mode: 0o755 },
    )
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`
    await fn()
  } finally {
    process.env.PATH = savedPath
    await rm(dir, { recursive: true, force: true })
  }
}
