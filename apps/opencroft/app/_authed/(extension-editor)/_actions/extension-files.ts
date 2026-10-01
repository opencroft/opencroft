import { promises as fs } from 'node:fs'
import path from 'node:path'

// Reading an extension folder's source files for the editor.

/**
 * The size past which a file in an extension is not treated as source.
 *
 * Every path here ends up in a record that is serialized to a browser, and
 * the only thing that reads one is an editor. Half a megabyte is far above
 * any file a person edits and far below the assets that made this expensive:
 * one extension ships a 27 MB WebAssembly build, and reading it as UTF-8
 * turned it into 137 MB of replacement characters in the response.
 */
const MAX_SOURCE_FILE_BYTES = 512 * 1024

/** Folders that are never source: build output, dependencies, git. */
const SKIPPED_DIRS = ['dist', 'node_modules', '.git']

/**
 * A file's text, or null when it is not text.
 *
 * Size is checked before the read, so a large binary is never loaded at all,
 * and a NUL byte decides the rest: it cannot occur in a UTF-8 text file and
 * occurs almost immediately in anything compiled. Skipped files are simply
 * absent from the record — no caller writes back what it did not read, since
 * updating an extension writes the files it is handed and deletes nothing.
 */
async function readSourceFile(file: string): Promise<string | null> {
  let size: number
  try {
    size = (await fs.stat(file)).size
  } catch {
    return null
  }
  if (size > MAX_SOURCE_FILE_BYTES) {
    return null
  }
  let buffer: Buffer
  try {
    buffer = await fs.readFile(file)
  } catch {
    return null
  }
  return buffer.includes(0) ? null : buffer.toString('utf-8')
}

/** Every source file under `dir`, keyed by its path relative to `dir`. */
export async function listSourceFiles(dir: string, base = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.includes(entry.name)) {
        Object.assign(files, await listSourceFiles(full, rel))
      }
      continue
    }
    const content = await readSourceFile(full)
    if (content !== null) {
      files[rel] = content
    }
  }
  return files
}

export async function dirMtime(dir: string): Promise<number> {
  try {
    return (await fs.stat(dir)).mtimeMs
  } catch {
    return 0
  }
}
