import type { CodeEditorLanguage } from './code-editor'

// Extension to Monaco language id, for the callers that have a file name and
// would otherwise show a diff of somebody's YAML in the colours of nothing at
// all. Only the extensions our own tools actually hand around; anything else
// is `plaintext`, which is what an unrecognised file has always looked like.
//
// The git extension and the design kit each carry a table like this one. They
// should reach for this instead once it is on the extension surface; until
// then, three tables is the honest count and pretending otherwise by deleting
// theirs from here would just hide it.
const LANGUAGE_BY_EXTENSION: Record<string, CodeEditorLanguage> = {
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

/**
 * The language to colour a file's contents in, from its name.
 *
 * Takes anything, because the callers have a label rather than a path: a tool
 * view shows a file edit under its path but a node's property under a property
 * name, and both arrive here. A label that is not a file name simply has no
 * extension to recognise, so it lands on `plaintext` — which is where it was
 * before this existed.
 */
export function languageFromPath(label?: string | null): CodeEditorLanguage {
  const name = (label ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    // A dotfile is all extension and no name (`.gitignore`), which is not an
    // extension we would recognise anyway, and a name with no dot has nothing
    // to read.
    return 'plaintext'
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}
