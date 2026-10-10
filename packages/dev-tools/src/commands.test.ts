// fix and typecheck end to end, in scratch repositories shaped like an
// extension: no biome config of its own, a components.json, a remote it was
// cloned from. Run as a child process, the way npm runs them, against the real
// biome and the real tsc of this core tree.
//
// What is pinned is SCOPE and VERDICT. fix must write the files the branch
// changed and nothing else (not an untouched unformatted file, not one that
// arrived by merging the base, not an installed one even when the branch
// edited it), and its verdict must cover every file of the repository except
// installed ones, failing on any lint finding or type error left anywhere.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'opencroft-dev.mjs')
// Where typecheck stages a copy of a repository outside the core tree.
const WORK_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'apps', 'opencroft', '.opencroft-dev')

// Unformatted by the shared config (double quotes, semicolons), and lint-clean.
const UNFORMATTED = 'export const value = "x";\n'
const FORMATTED = "export const value = 'x'\n"
// Formatted and lint-clean, and a type error.
const MISTYPED = "export const count: number = 'x'\n"
// Formatted and type-correct, and a finding fix cannot repair.
const UNSAFE = 'export const echo = (input: any) => input\n'

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

function write(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  }
}

function run(cwd: string, ...args: string[]) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Remove a scratch directory and whatever typecheck staged for the package named `name`. */
function cleanup(dir: string, name: string) {
  rmSync(dir, { recursive: true, force: true })
  for (const sub of ['extensions', 'projects']) {
    const parent = path.join(WORK_DIR, sub)
    if (!existsSync(parent)) {
      continue
    }
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(`${name}-`)) {
        rmSync(path.join(parent, entry), { recursive: true, force: true })
      }
    }
  }
}

/** A remote holding one commit, a task clone of it on its own branch, and the seed clone that can push more. */
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-tools-commands-'))
  const name = `ext-${randomBytes(4).toString('hex')}`
  const origin = path.join(dir, 'origin.git')
  const seed = path.join(dir, 'seed')
  const work = path.join(dir, 'work')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, seed)
  write(seed, {
    'package.json': `{\n  "name": "${name}",\n  "private": true\n}\n`,
    'components.json': '{ "aliases": { "ui": "@/components/ui", "hooks": "@/hooks" } }\n',
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
    'src/components/ui/button.tsx': UNFORMATTED,
    'src/old.ts': UNFORMATTED,
    'src/old2.ts': UNFORMATTED,
    'src/clean.ts': FORMATTED,
  })
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'seed')
  git(seed, 'push', '-q', 'origin', 'main')
  git(dir, 'clone', '-q', origin, work)
  git(work, 'checkout', '-q', '-b', 'task')
  return { dir, name, origin, seed, work }
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8')

test('fix writes only what the branch changed: not untouched files, not the merged base, not installed files', () => {
  const { dir, name, seed, work } = setup()
  try {
    // The base moves on after the branch was cut, and the branch merges it in.
    write(seed, { 'src/later.ts': UNFORMATTED })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'later')
    git(seed, 'push', '-q', 'origin', 'main')
    git(work, 'fetch', '-q')
    git(work, 'merge', '-q', '--no-edit', 'origin/main')

    // The task: one new file, one committed edit, one edit to an installed file.
    write(work, { 'src/new.ts': UNFORMATTED, 'src/edited.ts': UNFORMATTED })
    git(work, 'add', 'src/edited.ts')
    git(work, 'commit', '-q', '-m', 'edit')
    write(work, { 'src/components/ui/button.tsx': `${UNFORMATTED}export const other = "y";\n` })

    const result = run(work, 'fix')
    assert.match(result.output, /files changed against origin\/main/)
    assert.match(result.output, /1 installed file\(s\) left alone/)

    assert.equal(read(work, 'src/new.ts'), FORMATTED, 'an untracked new file is the branch’s')
    assert.equal(read(work, 'src/edited.ts'), FORMATTED, 'a committed file is the branch’s')
    assert.equal(read(work, 'src/old.ts'), UNFORMATTED, 'an untouched file is not')
    assert.equal(read(work, 'src/later.ts'), UNFORMATTED, 'a file merged in from the base is not')
    assert.match(read(work, 'src/components/ui/button.tsx'), /"y";/, 'an installed file is never written')

    // The files it left alone are still findings: the verdict is the whole repository's.
    assert.equal(result.status, 1, result.output)
    for (const file of ['src/later.ts', 'src/old.ts', 'src/old2.ts']) {
      assert.match(result.output, new RegExp(`${file.replace('.', '\\.')} +format`), file)
    }
    assert.doesNotMatch(result.output, /button\.tsx:/, 'an installed file is never a finding')
    assert.match(result.output, /verdict +FAIL \(write ok, lint findings, typecheck ok\)/)
  } finally {
    cleanup(dir, name)
  }
})

test('fix --all reaches every own file, leaves installed files alone, and then passes', () => {
  const { dir, name, work } = setup()
  try {
    const result = run(work, 'fix', '--all')
    assert.equal(result.status, 0, result.output)
    assert.equal(read(work, 'src/old.ts'), FORMATTED)
    assert.equal(read(work, 'src/old2.ts'), FORMATTED)
    assert.equal(read(work, 'src/components/ui/button.tsx'), UNFORMATTED)
    assert.match(result.output, /lint +\d+ file\(s\), 0 finding\(s\)/)
    assert.match(result.output, /verdict +PASS/)
  } finally {
    cleanup(dir, name)
  }
})

test('fix fails on a lint finding it cannot repair, in a file the branch did not touch', () => {
  const { dir, name, seed, work } = setup()
  try {
    assert.equal(run(work, 'fix', '--all').status, 0)
    git(work, 'commit', '-q', '-am', 'format')
    // Arrives from the base, so the branch never changed it.
    write(seed, { 'src/unsafe.ts': UNSAFE })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'unsafe')
    git(seed, 'push', '-q', 'origin', 'main')
    git(work, 'fetch', '-q')
    git(work, 'merge', '-q', '--no-edit', 'origin/main')

    const result = run(work, 'fix')
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /src\/unsafe\.ts:1:\d+ +lint\/suspicious\/noExplicitAny/)
    assert.equal(read(work, 'src/unsafe.ts'), UNSAFE, 'a file outside the change is not written')

    // CONTROL: the same content in an installed file is not a finding.
    rmSync(path.join(work, 'src/unsafe.ts'))
    write(work, { 'src/components/ui/unsafe.tsx': UNSAFE })
    const installed = run(work, 'fix')
    assert.equal(installed.status, 0, installed.output)
  } finally {
    cleanup(dir, name)
  }
})

test('fix and typecheck fail on a type error and pass once it is gone', () => {
  const { dir, name, work } = setup()
  try {
    assert.equal(run(work, 'fix', '--all').status, 0)
    write(work, { 'src/mistyped.ts': MISTYPED })

    const fixed = run(work, 'fix')
    assert.equal(fixed.status, 1, fixed.output)
    assert.match(fixed.output, /src\/mistyped\.ts:1 +error TS2322/)
    assert.match(fixed.output, /verdict +FAIL \(write ok, lint ok, typecheck findings\)/)

    const alone = run(work, 'typecheck')
    assert.equal(alone.status, 1, alone.output)
    assert.match(alone.output, /src\/mistyped\.ts:1 +error TS2322/)

    // CONTROL: the same run with the error removed passes, so the failure above was the error.
    rmSync(path.join(work, 'src/mistyped.ts'))
    const clean = run(work, 'typecheck')
    assert.equal(clean.status, 0, clean.output)
    assert.match(clean.output, /verdict +PASS/)
  } finally {
    cleanup(dir, name)
  }
})

test('typecheck reports a planted type error in a worktree of a bare clone', () => {
  // The layout task worktrees have: a bare repository and a worktree beside it,
  // outside any core tree.
  const { dir, name, origin } = setup()
  try {
    const worktree = path.join(dir, 'worktree')
    git(dir, '--git-dir', origin, 'worktree', 'add', '-q', '-b', 'task', worktree, 'main')
    write(worktree, { 'src/mistyped.ts': MISTYPED })
    const result = run(worktree, 'typecheck')
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /checked +as a copy/)
    assert.match(result.output, /src\/mistyped\.ts:1 +error TS2322/)
  } finally {
    cleanup(dir, name)
  }
})

test('typecheck refuses a repository with no TypeScript rather than passing it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-tools-nots-'))
  const name = `ext-${randomBytes(4).toString('hex')}`
  try {
    git(dir, 'init', '-q', '-b', 'main')
    write(dir, { 'package.json': `{ "name": "${name}" }\n`, 'index.js': FORMATTED })
    const result = run(dir, 'typecheck')
    assert.equal(result.status, 2, result.output)
    assert.match(result.output, /no \.ts or \.tsx file/)
  } finally {
    cleanup(dir, name)
  }
})

test('fix names the way out when it cannot tell the base branch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-tools-nobase-'))
  const name = `ext-${randomBytes(4).toString('hex')}`
  try {
    git(dir, 'init', '-q', '-b', 'main')
    write(dir, { 'package.json': `{ "name": "${name}" }\n`, 'a.ts': UNFORMATTED })
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'a')
    const result = run(dir, 'fix')
    assert.equal(result.status, 2, result.output)
    assert.match(result.output, /pass --base/)
    assert.equal(read(dir, 'a.ts'), UNFORMATTED)

    // With a base, nothing is in scope to write, and the untouched file is still a finding.
    const explicit = run(dir, 'fix', '--base', 'HEAD')
    assert.match(explicit.output, /nothing to write/)
    assert.equal(explicit.status, 1, explicit.output)
    assert.equal(read(dir, 'a.ts'), UNFORMATTED)
  } finally {
    cleanup(dir, name)
  }
})
