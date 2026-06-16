import { execSync } from 'child_process'

import { createFileRoute } from '@tanstack/react-router'

let cached: { branch: string; commit: string } | null = null

function getBuildInfo() {
  if (cached) {
    return cached
  }
  let branch = process.env.OPENCROFT_BRANCH || 'unknown'
  let commit = process.env.OPENCROFT_COMMIT || 'unknown'

  if (branch === 'unknown' || commit === 'unknown') {
    try {
      if (branch === 'unknown') {
        branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim()
      }
      if (commit === 'unknown') {
        commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim()
      }
    } catch {
      // running outside git context
    }
  }

  cached = { branch, commit }
  return cached
}

export const Route = createFileRoute('/api/build-info')({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(getBuildInfo())
      },
    },
  },
})
