import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules')
const dst = resolve(root, process.argv[2] || 'extension-deps')

const roots = [
  '@xterm/xterm',
  '@xterm/addon-fit',
  '@uiw/react-codemirror',
  '@codemirror/theme-one-dark',
  '@codemirror/lang-javascript',
  '@codemirror/lang-python',
  'js-yaml',
]

function resolvePkg(name, from) {
  let dir = from
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

const visited = new Set()
const missing = new Set()

function visit(name, from) {
  const dir = resolvePkg(name, from)
  if (!dir) {
    missing.add(name)
    return
  }
  if (visited.has(dir)) {
    return
  }
  visited.add(dir)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
  const deps = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
  }
  for (const dep of Object.keys(deps)) {
    visit(dep, dir)
  }
}

for (const name of roots) {
  visit(name, root)
}

mkdirSync(dst, { recursive: true })
for (const dir of visited) {
  const rel = dir.slice(src.length + 1)
  cpSync(dir, join(dst, rel), { recursive: true, force: true })
}

console.log(`[extension-deps] copied ${visited.size} packages to ${dst}`)
if (missing.size > 0) {
  console.log(`[extension-deps] unresolved peers: ${[...missing].join(', ')}`)
}
