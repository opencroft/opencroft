#!/usr/bin/env node

// Fails if a file exporting a `createServerFn` also exports anything else.
//
// The client build replaces each `createServerFn` export with an RPC stub, so
// the real handler body — and with it the module's whole import tail — never
// reaches the browser. That is what lets a client component import a server
// module directly, which is the normal way to call a server function.
//
// One plain export in the same file removes that guarantee. There is no stub
// for it, so its live binding can keep the module's top-level imports in the
// client graph — `node:child_process`, a compiler, an SSH client — and the
// browser then fails to link the module graph. The page renders as a stuck
// spinner with a console error and nothing else to go on.
//
// This is a SOURCE check on purpose, and it is the half that answers "is this
// shape present", not "did it leak today". Whether the shape actually breaks
// the build depends on what the file's imports happen to reach and on how much
// the bundler can prove it is allowed to drop — so the same shape is harmless
// in one file and fatal in the next, and it changes category when an unrelated
// import is added somewhere down the tail. Waiting for the leak means finding
// out from a blank page.
//
// The companion check, `check-client-bundle.mjs`, is the other half: it reads
// the built output and fails on a leak that actually happened, whatever route
// it arrived by. Neither one subsumes the other.

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Comments are stripped before matching so that a file which merely MENTIONS
// `createServerFn` — including one whose comment explains why it deliberately
// holds no server function — is not mistaken for one that declares it. Every
// correctly-split `*-impl.ts` module in this tree carries exactly that comment.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SERVER_FN_EXPORT = /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*createServerFn\s*\(/gm
// Only runtime bindings. `export type` and `export interface` are erased before
// the bundler sees them and cannot hold an import tail open.
const RUNTIME_EXPORT = /^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm
// `export { a, b }` without `from` also exports local bindings. A re-export
// (`export { a } from './x'`) does not, since it binds another module's value
// and leaves this module's imports untouched.
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*(?!\s*from)[;\n]/gm

async function sourceFiles(dir, found = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.output' || entry.name === 'dist') {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await sourceFiles(full, found)
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

// Exported so the detector can be tested directly. The rule it encodes is not
// self-evidently right — the difference between a server function and a plain
// export is invisible in the source until you know what the client build does
// with each — so it is worth a test that fails when the rule stops telling the
// two shapes apart.
export function plainExportsBesideServerFn(source) {
  const code = stripComments(source)
  const serverFns = new Set()
  for (const match of code.matchAll(SERVER_FN_EXPORT)) {
    serverFns.add(match[1])
  }
  if (serverFns.size === 0) {
    return null
  }
  const plain = []
  for (const match of code.matchAll(RUNTIME_EXPORT)) {
    if (!serverFns.has(match[1])) {
      plain.push(match[1])
    }
  }
  for (const match of code.matchAll(EXPORT_LIST)) {
    for (const raw of match[1].split(',')) {
      // `a as b` exports the local binding `a`; the exported name is irrelevant.
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if (name && !name.startsWith('type ') && !serverFns.has(name)) {
        plain.push(name)
      }
    }
  }
  return plain.length > 0 ? { serverFns: [...serverFns], plain } : null
}

async function main() {
  const files = await sourceFiles(join(APP_DIR, 'app'))
  files.push(...(await sourceFiles(join(APP_DIR, 'server'))))

  const failures = []
  for (const file of files) {
    const found = plainExportsBesideServerFn(await readFile(file, 'utf8'))
    if (found) {
      failures.push({ file: relative(APP_DIR, file), ...found })
    }
  }

  if (failures.length > 0) {
    console.error('[check-server-fn-colocation] plain exports share a file with a server function:\n')
    for (const { file, serverFns, plain } of failures) {
      console.error(`  ${file}`)
      console.error(`    server functions: ${serverFns.join(', ')}`)
      console.error(`    also exported:    ${plain.join(', ')}`)
    }
    console.error(
      '\nMove the plain export into its own module that client code never imports —\n' +
        'the convention here is a sibling `*-impl.ts`. The file left behind should export\n' +
        'nothing but server functions, so the client build can stub every one of them and\n' +
        'drop the import tail. Making the import lazy does not help.\n',
    )
    process.exit(1)
  }

  console.log(
    `[check-server-fn-colocation] ok — ${files.length} source files, no plain export beside a server function`,
  )
}

// Only when run as a script. Importing this module — which the test does —
// must not run the check or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
