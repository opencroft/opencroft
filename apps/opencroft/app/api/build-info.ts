import { execSync } from 'child_process'

import { createFileRoute } from '@tanstack/react-router'

export interface BuildInfo {
  branch: string
  commit: string
  deployedAt: string | null
}

// Resolved once, when this module is first loaded at process start, and kept
// as a plain module-level value rather than recomputed per request — a
// deploy sets OPENCROFT_COMMIT/OPENCROFT_BRANCH/OPENCROFT_DEPLOYED_AT before
// starting this process, so the answer reflects what the running process was
// actually built from, and cannot drift if the checkout on disk moves later
// without a restart. The container image sets them at build time. The git
// fallback exists only for a context that never set those (e.g. a bare local
// `npm run dev`); it is still read once at import time rather than at whatever
// moment the first request happens to land, which is what let the old
// implementation report a moved checkout. Outside a checkout it answers
// "unknown" without passing git's error through to the log.
export function resolveBuildInfo(): BuildInfo {
  let branch = process.env.OPENCROFT_BRANCH
  let commit = process.env.OPENCROFT_COMMIT
  const deployedAt = process.env.OPENCROFT_DEPLOYED_AT ?? null

  if (!branch || !commit) {
    const git = (args: string) =>
      execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    try {
      branch ??= git('rev-parse --abbrev-ref HEAD')
      commit ??= git('rev-parse HEAD')
    } catch {
      // running outside a git checkout
    }
  }

  return { branch: branch ?? 'unknown', commit: commit ?? 'unknown', deployedAt }
}

const buildInfo = resolveBuildInfo()

export const Route = createFileRoute('/api/build-info')({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(buildInfo)
      },
    },
  },
})
