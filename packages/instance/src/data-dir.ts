import path from 'node:path'

/** A path inside the instance's data directory: `OPENCROFT_DATA_DIR`, or `data` under the working directory. */
export function dataDir(...segments: string[]): string {
  const base = process.env.OPENCROFT_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(base, ...segments)
}
