import { createHash } from 'node:crypto'

// The one hash every bearer credential is stored under — personal access
// tokens and MCP tokens alike. Issuing and resolving must agree on it exactly:
// a mismatch means every token silently fails to resolve, and nothing reports
// why. So both sides import this rather than spelling the digest out.
//
// Its own module with no dependency beyond node:crypto, so importing it never
// opens the database as a side effect — `@opencroft/db` does at module load.
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
