import path from 'node:path'

export function dataDir(...segments: string[]): string {
  const base = process.env.OPENCROFT_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(base, ...segments)
}
