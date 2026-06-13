import fs from 'node:fs/promises'
import path from 'node:path'

import { createFileRoute } from '@tanstack/react-router'

import { getGitFileAtRef } from '@/app/(docs)/_server/actions'
import { getDocsRoot } from '@/app/(docs)/_server/docs-root'

interface DocEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: DocEntry[]
}

function isPathSafe(root: string, filePath: string): boolean {
  const resolved = path.resolve(root, filePath)
  return resolved.startsWith(root)
}

async function readDirRecursive(root: string, dirPath: string): Promise<DocEntry[]> {
  const resolved = path.resolve(root, dirPath)
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const results: DocEntry[] = []
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1
      }
      return a.name.localeCompare(b.name)
    })
    for (const entry of sorted) {
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(root, fullPath)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          continue
        }
        const children = await readDirRecursive(root, relativePath)
        if (
          children.some((c) => c.type === 'file' || (c.type === 'directory' && c.children && c.children.length > 0))
        ) {
          results.push({ name: entry.name, path: relativePath, type: 'directory', children })
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({ name: entry.name, path: relativePath, type: 'file' })
      }
    }
    return results
  } catch {
    return []
  }
}

export const Route = createFileRoute('/(docs)/docs/api/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams } = new URL(request.url)
        const filePath = searchParams.get('file')
        const namespace = searchParams.get('namespace') ?? undefined
        const root = await getDocsRoot(namespace)
        if (!root) {
          return Response.json({ error: 'No documentation repository configured' }, { status: 404 })
        }

        if (filePath) {
          if (!isPathSafe(root, filePath) || !filePath.endsWith('.md')) {
            return Response.json({ error: 'Access denied' }, { status: 403 })
          }
          if (namespace) {
            const headContent = await getGitFileAtRef({ data: { namespace, filePath, ref: 'HEAD' } })
            if (headContent !== null) {
              return Response.json({ content: headContent, name: path.basename(filePath) })
            }
          }
          try {
            const content = await fs.readFile(path.resolve(root, filePath), 'utf-8')
            return Response.json({ content, name: path.basename(filePath) })
          } catch {
            return Response.json({ error: 'File not found' }, { status: 404 })
          }
        }

        const tree = await readDirRecursive(root, '')
        return Response.json(tree)
      },
    },
  },
})
