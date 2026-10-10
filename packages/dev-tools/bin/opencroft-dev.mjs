#!/usr/bin/env node
// The command every OpenCroft repository runs before a commit, as
// `npm run fix`, and the typecheck it ends with, as `npm run typecheck`. They
// act on the repository of the working directory, with the biome config and
// binary of the core tree this file belongs to.
//
// npm puts every ancestor's node_modules/.bin on PATH, so an extension checkout
// inside a core tree finds this command with no setup. From anywhere else, put
// a core checkout's node_modules/.bin on PATH first.

import { fix } from '../src/fix.mjs'
import { repoRoot } from '../src/repo.mjs'
import { typecheck } from '../src/typecheck.mjs'

const USAGE = `usage: opencroft-dev <command> [options]

  fix [--all] [--base <ref>]   biome's safe fixes and formatting, written to disk on the files
                               changed against the base branch (every file with --all), then
                               biome over the whole repository and the typecheck; fails on
                               any finding or type error left
  typecheck                    the typecheck alone: every workspace in the core repository,
                               tsc against the host's types in an extension repository

Installed shadcn / design-kit files (under a components.json's ui and hooks aliases, and the
kit's <components>/hooks) are never written or linted.`

const [command, ...args] = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? null : (args[at + 1] ?? null)
}

let code
try {
  const root = repoRoot(process.cwd())
  switch (command) {
    case 'fix':
      code = fix(root, { all: flag('--all'), base: option('--base') })
      break
    case 'typecheck':
      code = typecheck(root)
      break
    default:
      console.error(USAGE)
      code = command === undefined || command === '--help' ? 0 : 2
  }
} catch (err) {
  console.error(`opencroft-dev ${command ?? ''}: ${err.message}`)
  code = 2
}
process.exit(code)
