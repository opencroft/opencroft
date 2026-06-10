import fs from 'node:fs/promises'
import path from 'node:path'

import { getDocsRoot } from '@/app/(docs)/_server/docs-root'

export interface Anchor {
  quote: string
  prefix?: string
  suffix?: string
}

export interface Comment {
  id: string
  author: string
  message: string
  timestamp: number
  anchor?: Anchor
  replies: Comment[]
}

interface CommentFile {
  version: 1
  comments: Comment[]
}

async function resolveCommentsPath(namespace: string, docPath: string): Promise<string> {
  if (!docPath.endsWith('.md')) {
    throw new Error('Only .md files have comments')
  }
  const root = await getDocsRoot(namespace)
  if (!root) {
    throw new Error(`No documentation repository configured for namespace "${namespace}"`)
  }
  const resolved = path.resolve(root, docPath)
  if (!resolved.startsWith(root)) {
    throw new Error('Access denied')
  }
  return `${resolved}.comments`
}

export async function readComments(namespace: string, docPath: string): Promise<Comment[]> {
  const file = await resolveCommentsPath(namespace, docPath)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw) as CommentFile
    return parsed.comments ?? []
  } catch {
    return []
  }
}

async function writeCommentsTree(namespace: string, docPath: string, comments: Comment[]): Promise<void> {
  const file = await resolveCommentsPath(namespace, docPath)
  const payload: CommentFile = { version: 1, comments }
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8')
}

function findAndPush(nodes: Comment[], parentId: string, reply: Comment): boolean {
  for (const node of nodes) {
    if (node.id === parentId) {
      node.replies.push(reply)
      return true
    }
    if (findAndPush(node.replies, parentId, reply)) {
      return true
    }
  }
  return false
}

export function createComment(author: string, message: string, anchor?: Anchor): Comment {
  return {
    id: crypto.randomUUID(),
    author,
    message,
    timestamp: Date.now(),
    ...(anchor ? { anchor } : {}),
    replies: [],
  }
}

export async function appendComment(namespace: string, docPath: string, comment: Comment, parentId?: string): Promise<void> {
  const comments = await readComments(namespace, docPath)
  if (parentId) {
    if (!findAndPush(comments, parentId, comment)) {
      throw new Error(`Parent comment not found: ${parentId}`)
    }
  } else {
    comments.push(comment)
  }
  await writeCommentsTree(namespace, docPath, comments)
}

function hasDescendant(node: Comment, id: string): boolean {
  if (node.id === id) {
    return true
  }
  return node.replies.some((r) => hasDescendant(r, id))
}

export function findThreadRoot(comments: Comment[], commentId: string): Comment | null {
  for (const root of comments) {
    if (hasDescendant(root, commentId)) {
      return root
    }
  }
  return null
}
