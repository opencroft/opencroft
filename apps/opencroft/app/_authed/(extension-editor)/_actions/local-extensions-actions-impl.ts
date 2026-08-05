import { runGit } from '@/app/_authed/(extension-runtime)/_server/git-exec'

// The durable half of "is this instance running that
// change?" -- a manifest version is hand-maintained and a directory mtime
// (see dirMtime in local-extensions-actions.ts) moves on anything that
// touches an entry in it, not specifically on a deploy. A commit read
// straight from the checkout is neither: it is exactly what the repository
// would call this code.
//
// Lives in this -impl module (not local-extensions-actions.ts) so that file
// exports nothing but server functions -- the client build stubs every
// export there, and a plain export would drag this import tail into the
// client bundle (see scripts/check-server-fn-colocation.mjs).
export async function readGitState(dir: string): Promise<{ sourceCommit: string | null; sourceDirty: boolean | null }> {
  try {
    const { stdout: head } = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const { stdout: status } = await runGit(['-C', dir, 'status', '--porcelain'])
    return { sourceCommit: head.trim(), sourceDirty: status.trim().length > 0 }
  } catch {
    return { sourceCommit: null, sourceDirty: null }
  }
}
