import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/

export interface DocSearchMatch {
  line: number
  text: string
  heading: string | null
}

export interface DocSearchResult {
  path: string
  title: string | null
  matches: DocSearchMatch[]
}

interface RawMatch {
  line: number
  text: string
}

async function runGitGrep(root: string, pattern: string): Promise<string> {
  try {
    const r = await exec('git', ['-c', 'safe.directory=*', '-C', root, 'grep', '-n', '-i', '-E', '--', pattern, 'HEAD', '--', '*.md'], { maxBuffer: 10 * 1024 * 1024 })
    return r.stdout
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    if (e.code === 1) {
      return e.stdout ?? ''
    }
    throw err
  }
}

async function runGitShow(root: string, filePath: string): Promise<string> {
  try {
    const r = await exec('git', ['-c', 'safe.directory=*', '-C', root, 'show', `HEAD:${filePath}`], { maxBuffer: 10 * 1024 * 1024 })
    return r.stdout
  } catch {
    return ''
  }
}

function parseGrep(stdout: string, maxResults: number): Map<string, RawMatch[]> {
  const byFile = new Map<string, RawMatch[]>()
  let total = 0
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue
    }
    const m = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/)
    if (!m) {
      continue
    }
    if (total >= maxResults) {
      break
    }
    const file = m[1]
    let arr = byFile.get(file)
    if (!arr) {
      arr = []
      byFile.set(file, arr)
    }
    arr.push({ line: Number(m[2]), text: m[3] })
    total += 1
  }
  return byFile
}

function extractTitle(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (m) {
      return m[1]
    }
  }
  return null
}

function nearestHeading(lines: string[], lineNo: number): string | null {
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = lines[i]?.match(HEADING_RE)
    if (m) {
      return m[2]
    }
  }
  return null
}

async function enrichResults(root: string, byFile: Map<string, RawMatch[]>): Promise<DocSearchResult[]> {
  const out: DocSearchResult[] = []
  for (const [file, raw] of byFile) {
    const content = await runGitShow(root, file)
    const lines = content.split('\n')
    const title = extractTitle(lines)
    const matches: DocSearchMatch[] = raw.map((r) => ({
      line: r.line,
      text: r.text,
      heading: nearestHeading(lines, r.line),
    }))
    out.push({ path: file, title, matches })
  }
  return out
}

/**
 * Search markdown files in a docs repo's HEAD via `git grep`, then enrich
 * each result with the document's title (first H1) and the nearest
 * preceding heading per match.
 */
export async function searchDocsAtRoot(root: string, pattern: string, maxResults: number): Promise<DocSearchResult[]> {
  if (!pattern.trim()) {
    return []
  }
  const stdout = await runGitGrep(root, pattern)
  const byFile = parseGrep(stdout, maxResults)
  return enrichResults(root, byFile)
}
