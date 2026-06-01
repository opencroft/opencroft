import { createServerFn } from '@tanstack/react-start'
import fs from 'fs/promises'
import path from 'path'

import { type Anchor, appendComment, type Comment, createComment, findThreadRoot, readComments } from '@/app/(docs)/_server/comments'
import { getDocsRoot } from '@/app/(docs)/_server/docs-root'
import { type DocSearchResult, searchDocsAtRoot } from '@/app/(docs)/_server/search'
import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader'
import { gateway } from '@/app/(openclaw)/_server/gateway-client'
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
    const mod = await getExtensionModule('builtin/core')
    const fn = mod.actions?.['docs.findDocNodeId']
    if (!fn) {
      return null
    }
    return (await fn({ namespace })) as string | null
  } catch {
    return null
  }
}

async function callDocsAction(action: string, params: Record<string, unknown>) {
  const mod = await getExtensionModule('builtin/core')
  const fn = mod.actions?.[action]
  if (!fn) {
    throw new Error(`Action ${action} not found`)
  }
  return fn(params)
}

export const getGitFileLog = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string; count?: number }) => data)
  .handler(async ({ data }): Promise<Array<{ sha: string; message: string; author: string; date: string }>> => {
    const nodeId = await findDocNodeId(data.namespace)
    if (!nodeId) {
      return []
    }
    try {
      return (await callDocsAction('docs.log', { nodeId, filePath: data.filePath, count: data.count ?? 20 })) as Array<{ sha: string; message: string; author: string; date: string }>
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
    return (await callDocsAction('docs.publish', { nodeId, filePath: data.filePath, message: data.message })) as { sha: string; message: string }
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

function extractMentions(message: string): string[] {
  const matches = message.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)
  const names = new Set<string>()
  for (const m of matches) {
    names.add(m[1])
  }
  return [...names]
}

function formatAgentPrompt(docPath: string, comment: Comment, isReply: boolean, threadRootId?: string): string {
  const kind = isReply ? 'reply' : 'comment'
  const lines = [`A user ${kind} was posted on doc "${docPath}" (commentId: ${comment.id}):`]
  if (comment.anchor?.quote) {
    lines.push('', `Anchored to the following passage in the doc:`, '> ' + comment.anchor.quote.replace(/\n/g, '\n> '))
  }
  lines.push('', comment.message, '')
  const replyId = threadRootId ?? comment.id
  lines.push(`Use the \`doc_reply\` MCP tool with docPath="${docPath}" and commentId="${replyId}" to respond in this thread.`)
  return lines.join('\n')
}

async function dispatchMentions(docPath: string, comment: Comment, threadRootId: string): Promise<void> {
  const agents = extractMentions(comment.message)
  if (agents.length === 0) {
    return
  }
  const isReply = threadRootId !== comment.id
  const prompt = formatAgentPrompt(docPath, comment, isReply, threadRootId)
  await Promise.all(
    agents.map(async (name) => {
      try {
        await gateway().call('chat.send', {
          sessionKey: `agent:${name}:main`,
          message: prompt,
          idempotencyKey: crypto.randomUUID(),
        })
      } catch (e) {
        console.error(`Failed to dispatch to agent:${name}`, e)
      }
    }),
  )
}

export const listDocComments = createServerFn()
  .inputValidator((data: { namespace: string; filePath: string }) => data)
  .handler(async ({ data }): Promise<Comment[]> => {
    return readComments(data.namespace, data.filePath)
  })

export const postDocComment = createServerFn({ method: 'POST' })
  .inputValidator((data: { namespace: string; filePath: string; message: string; parentId?: string; anchor?: Anchor }) => data)
  .handler(async ({ data }): Promise<Comment> => {
    const trimmed = data.message.trim()
    if (!trimmed) {
      throw new Error('Comment cannot be empty')
    }
    const comment = createComment('user', trimmed, data.parentId ? undefined : data.anchor)
    await appendComment(data.namespace, data.filePath, comment, data.parentId)
    toastStore.broadcast({ type: 'doc_comments_updated', docPath: data.filePath })
    let threadRootId = comment.id
    if (data.parentId) {
      const all = await readComments(data.namespace, data.filePath)
      const root = findThreadRoot(all, data.parentId)
      if (root) {
        threadRootId = root.id
      }
    }
    await dispatchMentions(data.filePath, comment, threadRootId)
    return comment
  })
