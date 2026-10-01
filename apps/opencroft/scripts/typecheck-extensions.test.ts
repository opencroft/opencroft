// Which folders typecheck-extensions.mjs reads: the `local.*` ones of the one
// extensions root under the data dir. Run as a child process, since the script
// is a command rather than a module; every folder holds no source file, so the
// run reports each it selects as "no source files" without invoking tsc.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'

const SCRIPT = path.join(import.meta.dirname, 'typecheck-extensions.mjs')
// The script finds tsc by walking up from its working directory, so a scratch
// working directory borrows the workspace's node_modules.
const WORKSPACE_MODULES = path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules')

/** Names that are and are not local folders, including the near misses a looser pattern would take. */
const FOLDERS = [
  'local.alpha',
  'local.beta-2',
  'acme.gamma',
  'builtin.delta',
  'local',
  'local.',
  'local.Upper',
  'local.a.b',
  'notlocal.alpha',
  'local-alpha',
]

interface Run {
  status: number | null
  listed: string[]
  output: string
}

/** Run the script from a scratch app root whose data dir holds `folders` under `extensions/`. */
function runWith(options: { dataDir?: 'default' | 'override'; env?: Record<string, string> }): Run {
  const appRoot = mkdtempSync(path.join(tmpdir(), 'typecheck-ext-'))
  try {
    symlinkSync(WORKSPACE_MODULES, path.join(appRoot, 'node_modules'), 'junction')
    const dataDir = options.dataDir === 'override' ? path.join(appRoot, 'elsewhere') : path.join(appRoot, 'data')
    for (const name of FOLDERS) {
      mkdirSync(path.join(dataDir, 'extensions', name), { recursive: true })
    }
    // A folder in the default location that must be ignored when the data dir is overridden.
    mkdirSync(path.join(appRoot, 'data', 'extensions', 'local.decoy'), { recursive: true })

    const env: Record<string, string | undefined> = { ...process.env, ...options.env }
    delete env.OPENCROFT_DATA_DIR
    if (options.dataDir === 'override') {
      env.OPENCROFT_DATA_DIR = dataDir
    }
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: appRoot, env, encoding: 'utf8' })
    const output = `${result.stdout}${result.stderr}`
    const listed = [...output.matchAll(/^ {2}(\S+)\s+no source files$/gm)].map((match) => match[1]).sort()
    return { status: result.status, listed, output }
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
}

test('CONTROL: the folder list has both local and non-local names', () => {
  assert.ok(FOLDERS.some((name) => isLocalFolder(name)))
  assert.ok(FOLDERS.some((name) => !isLocalFolder(name)))
})

test('only local.* folders of the data dir default are typechecked, by the same rule as isLocalFolder', () => {
  const run = runWith({ dataDir: 'default' })

  const expected = [...FOLDERS.filter((name) => isLocalFolder(name)), 'local.decoy'].sort()
  assert.deepEqual(run.listed, expected, run.output)
  assert.equal(run.status, 0, run.output)
})

test('OPENCROFT_DATA_DIR moves the root, and the removed per-root variable no longer does', () => {
  const run = runWith({
    dataDir: 'override',
    env: { OPENCROFT_LOCAL_EXTENSIONS: path.join(tmpdir(), 'no-such-root-for-typecheck-test') },
  })

  const expected = FOLDERS.filter((name) => isLocalFolder(name)).sort()
  assert.deepEqual(run.listed, expected, run.output)
  assert.ok(!run.listed.includes('local.decoy'), 'the default location is not read once the data dir is set')
  assert.match(run.output, /over .*elsewhere[\\/]extensions/)
})
