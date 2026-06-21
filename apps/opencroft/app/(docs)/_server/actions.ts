import fs from 'node:fs/promises'
import path from 'node:path'

import { createServerFn } from '@tanstack/react-start'

import { type Anchor, appendComment, type Comment, createComment, readComments } from '@/app/(docs)/_server/comments'
import { getDocsRoot } from '@/app/(docs)/_server/docs-root'
import { type DocSearchResult, searchDocsAtRoot } from '@/app/(docs)/_server/search'
import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader'
import { toastStore } from '@/lib/toast-store'

async function docsRoot(namespace: string): Promise<string> {
  const root = await getDocsRoot(namespace)
  if (!root) {
    throw new Error(`No documentation repository configured for namespace "${namespace}"`)
  }
  return root
}

async function resolveSafe(namespace: string, filePath: string): Promise<string> {
  if (!filePath.endsWith('.md')) {
    throw new Error('Only .md files are editable')
  }
  const root = await docsRoot(namespace)
  const resolved = path.resolve(root, filePath)
  if (!resolved.startsWith(root)) {
    throw new Error('Access denied')
  }
  return resolved
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Read working-tree content (includes uncommitted edits). */
export const readDocWorking = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string }) => data)
  .handler(async ({ data }): Promise<string> => {
    const resolved = await resolveSafe(data.namespace, data.filePath)
    return fs.readFile(resolved, 'utf-8')
  })

/** Write content to the working tree. */
export const saveDocDirectly = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; filePath: string; content: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const resolved = await resolveSafe(data.namespace, data.filePath)
    await fs.writeFile(resolved, data.content, 'utf-8')
  })

function normalizeNewPath(input: string): string {
  const clean = input
    .trim()
    .replace(/^[/\\]+|[/\\]+$/g, '')
    .replace(/\\/g, '/')
  if (!clean) {
    throw new Error('Path is empty')
  }
  return clean.endsWith('.md') ? clean : `${clean}.md`
}

export const createDoc = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; inputPath: string }) => data)
  .handler(async ({ data }): Promise<string> => {
    const relative = normalizeNewPath(data.inputPath)
    const root = await docsRoot(data.namespace)
    const resolved = path.resolve(root, relative)
    if (!resolved.startsWith(root)) {
      throw new Error('Access denied')
    }
    if (await exists(resolved)) {
      throw new Error('File already exists')
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    const title = path.basename(relative, '.md')
    await fs.writeFile(resolved, `# ${title}\n`, 'utf-8')
    return relative
  })

async function removeEmptyDirs(namespace: string, dir: string): Promise<void> {
  const root = await docsRoot(namespace)
  while (dir.length > root.length && dir.startsWith(root)) {
    const entries = await fs.readdir(dir)
    if (entries.length > 0) {
      return
    }
    await fs.rmdir(dir)
    dir = path.dirname(dir)
  }
}

export interface DocNamespace {
  id: string
  namespace: string
  name: string
}

export const listDocNamespaces = createServerFn().handler(async (): Promise<DocNamespace[]> => {
  try {
    const list = (await callDocsAction('docs.listNamespaces', {})) as DocNamespace[]
    return [...list].sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
})

export const searchDocs = createServerFn()
  .inputValidator((data: { namespace: string; pattern: string; maxResults?: number }) => data)
  .handler(async ({ data }): Promise<DocSearchResult[]> => {
    const root = await getDocsRoot(data.namespace)
    if (!root) {
      return []
    }
    return searchDocsAtRoot(root, data.pattern, data.maxResults ?? 50)
  })

export const deleteDoc = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; filePath: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const resolved = await resolveSafe(data.namespace, data.filePath)
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      throw new Error(`No documentation node found for namespace "${data.namespace}"`)
    }
    await callDocsAction('docs.deleteFile', { nodeId, filePath: data.filePath })
    await removeEmptyDirs(data.namespace, path.dirname(resolved))
  })

// ── Git-aware docs API ──────────────────────────────────────────────────

async function findDocNodeId(namespace?: string): Promise<string | null> {
  try {
    const { docProviderIds } = await import('@/app/(docs)/_server/docs-provider')
    for (const id of await docProviderIds()) {
      const mod = await getExtensionModule(id)
      const fn = mod.actions?.['docs.findDocNodeId']
      if (fn) {
        return (await fn({ namespace })) as string | null
      }
    }
    return null
  } catch {
    return null
  }
}

async function callDocsAction(action: string, params: Record<string, unknown>) {
  const { docProviderIds } = await import('@/app/(docs)/_server/docs-provider')
  for (const id of await docProviderIds()) {
    const mod = await getExtensionModule(id)
    const fn = mod.actions?.[action]
    if (fn) {
      return fn(params)
    }
  }
  throw new Error(`Action ${action} not found`)
}

export const getGitFileLog = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string; count?: number }) => data)
  .handler(async ({ data }): Promise<Array<{ sha: string; message: string; author: string; date: string }>> => {
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      return []
    }
    try {
      return (await callDocsAction('docs.log', { nodeId, filePath: data.filePath, count: data.count ?? 20 })) as Array<{
        sha: string
        message: string
        author: string
        date: string
      }>
    } catch {
      return []
    }
  })

export const getGitFileAtRef = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string; ref: string }) => data)
  .handler(async ({ data }): Promise<string | null> => {
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      return null
    }
    try {
      return (await callDocsAction('docs.show', { nodeId, filePath: data.filePath, ref: data.ref })) as string | null
    } catch {
      return null
    }
  })

export const getGitChangedFiles = createServerFn()
  .inputValidator((namespace: string) => namespace)
  .handler(async ({ data: namespace }): Promise<string[]> => {
    const nodeId = await findDocNodeId(namespace)
    if (!nodeId) {
      return []
    }
    try {
      const files = await callDocsAction('docs.changedFiles', { nodeId })
      return (files as { path: string }[]).map((f) => f.path)
    } catch {
      return []
    }
  })

export const gitPublishDocs = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; filePath: string; message: string }) => data)
  .handler(async ({ data }): Promise<{ sha: string; message: string }> => {
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      throw new Error(`No documentation node found for namespace "${data.namespace}"`)
    }
    return (await callDocsAction('docs.publish', { nodeId, filePath: data.filePath, message: data.message })) as {
      sha: string
      message: string
    }
  })

export const gitDiscardFile = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; filePath: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      throw new Error(`No documentation node found for namespace "${data.namespace}"`)
    }
    await callDocsAction('docs.discardFile', { nodeId, filePath: data.filePath })
  })

// ── Comments ─────────────────────────────────────────────────────────────

export const listDocComments = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string }) => data)
  .handler(async ({ data }): Promise<Comment[]> => {
    return readComments(data.namespace, data.filePath)
  })

export const postDocComment = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: { namespace: string; filePath: string; message: string; parentId?: string; anchor?: Anchor }) => data,
  )
  .handler(async ({ data }): Promise<Comment> => {
    const trimmed = data.message.trim()
    if (!trimmed) {
      throw new Error('Comment cannot be empty')
    }
    const comment = createComment('user', trimmed, data.parentId ? undefined : data.anchor)
    await appendComment(data.namespace, data.filePath, comment, data.parentId)
    toastStore.broadcast({ type: 'doc_comments_updated', docPath: data.filePath })
    return comment
  })
