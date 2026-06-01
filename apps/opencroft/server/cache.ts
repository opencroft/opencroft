import path from 'node:path'

export function cacheDir(...segments: string[]): string {
  const base = process.env.OPENCROFT_CACHE_DIR || path.join(process.cwd(), '.cache')
  return path.join(base, ...segments)
}
