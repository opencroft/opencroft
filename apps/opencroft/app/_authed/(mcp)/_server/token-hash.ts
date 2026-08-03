import { createHash } from 'node:crypto'

// Deliberately its own module with no dependencies beyond node:crypto.
//
// The minting script and the request path must agree on this function exactly
// — a mismatch means every token silently fails to resolve. But the script
// must NOT reach it through caller.ts, because that imports `@opencroft/db`,
// whose index opens the database at module load. The script opens the database
// itself, so importing caller.ts would give one process two PGlite handles on
// one datadir: no lock, no error, and one side's writes discarded on close
// (a silent data-loss case). Keeping the shared piece dependency-free is what stops that.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
