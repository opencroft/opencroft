'use server';

import fs from 'fs/promises';
import path from 'path';

import { type Anchor, appendComment, type Comment, createComment, findThreadRoot, readComments } from '@/app/(docs)/docs/_server/comments';
import { gateway } from '@/app/(openclaw)/_server/gateway-client';
import { toastStore } from '@/lib/toast-store';

const DOCS_ROOT = process.env.OPENCROFT_DOCS_ROOT ?? path.join(process.cwd(), 'app', 'docs');

function resolveSafe(filePath: string): string {
  if (!filePath.endsWith('.md')) {
    throw new Error('Only .md files are editable');
  }
  const resolved = path.resolve(DOCS_ROOT, filePath);
  if (!resolved.startsWith(DOCS_ROOT)) {
    throw new Error('Access denied');
  }
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function hasEditDraft(filePath: string): Promise<boolean> {
  const resolved = resolveSafe(filePath);
  return exists(`${resolved}.edit`);
}

export async function enterEditMode(filePath: string): Promise<string> {
  const resolved = resolveSafe(filePath);
  const draft = `${resolved}.edit`;
  if (await exists(draft)) {
    return fs.readFile(draft, 'utf-8');
  }
  const content = await fs.readFile(resolved, 'utf-8');
  await fs.writeFile(draft, content, 'utf-8');
  return content;
}

export async function saveEditDraft(filePath: string, content: string): Promise<void> {
  const resolved = resolveSafe(filePath);
  await fs.writeFile(`${resolved}.edit`, content, 'utf-8');
}

export async function publishEditDraft(filePath: string): Promise<string> {
  const resolved = resolveSafe(filePath);
  const draft = `${resolved}.edit`;
  const content = await fs.readFile(draft, 'utf-8');
  await fs.writeFile(resolved, content, 'utf-8');
  await fs.unlink(draft);
  return content;
}

export async function discardEditDraft(filePath: string): Promise<void> {
  const resolved = resolveSafe(filePath);
  await fs.unlink(`${resolved}.edit`);
}

function normalizeNewPath(input: string): string {
  const clean = input.trim().replace(/^[/\\]+|[/\\]+$/g, '').replace(/\\/g, '/');
  if (!clean) {
    throw new Error('Path is empty');
  }
  return clean.endsWith('.md') ? clean : `${clean}.md`;
}

export async function createDoc(inputPath: string): Promise<string> {
  const relative = normalizeNewPath(inputPath);
  const resolved = path.resolve(DOCS_ROOT, relative);
  if (!resolved.startsWith(DOCS_ROOT)) {
    throw new Error('Access denied');
  }
  if (await exists(resolved)) {
    throw new Error('File already exists');
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const title = path.basename(relative, '.md');
  await fs.writeFile(resolved, `# ${title}\n`, 'utf-8');
  return relative;
}

async function removeEmptyDirs(dir: string): Promise<void> {
  while (dir.length > DOCS_ROOT.length && dir.startsWith(DOCS_ROOT)) {
    const entries = await fs.readdir(dir);
    if (entries.length > 0) {
      return;
    }
    await fs.rmdir(dir);
    dir = path.dirname(dir);
  }
}

export async function deleteDoc(filePath: string): Promise<void> {
  const resolved = resolveSafe(filePath);
  if (await exists(`${resolved}.edit`)) {
    await fs.unlink(`${resolved}.edit`);
  }
  if (await exists(`${resolved}.comments`)) {
    await fs.unlink(`${resolved}.comments`);
  }
  await fs.unlink(resolved);
  await removeEmptyDirs(path.dirname(resolved));
}

// ── Comments ─────────────────────────────────────────────────────────────

function extractMentions(message: string): string[] {
  const matches = message.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m[1]);
  }
  return [...names];
}

function formatAgentPrompt(docPath: string, comment: Comment, isReply: boolean, threadRootId?: string): string {
  const kind = isReply ? 'reply' : 'comment';
  const lines = [`A user ${kind} was posted on doc "${docPath}" (commentId: ${comment.id}):`];
  if (comment.anchor?.quote) {
    lines.push('', `Anchored to the following passage in the doc:`, '> ' + comment.anchor.quote.replace(/\n/g, '\n> '));
  }
  lines.push('', comment.message, '');
  const replyId = threadRootId ?? comment.id;
  lines.push(`Use the \`doc_reply\` MCP tool with docPath="${docPath}" and commentId="${replyId}" to respond in this thread.`);
  return lines.join('\n');
}

async function dispatchMentions(docPath: string, comment: Comment, threadRootId: string): Promise<void> {
  const agents = extractMentions(comment.message);
  if (agents.length === 0) {
    return;
  }
  const isReply = threadRootId !== comment.id;
  const prompt = formatAgentPrompt(docPath, comment, isReply, threadRootId);
  await Promise.all(agents.map(async name => {
    try {
      await gateway().call('chat.send', {
        sessionKey: `agent:${name}:main`,
        message: prompt,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (e) {
      console.error(`Failed to dispatch to agent:${name}`, e);
    }
  }));
}

export async function listDocComments(filePath: string): Promise<Comment[]> {
  return readComments(filePath);
}

export async function postDocComment(filePath: string, message: string, parentId?: string, anchor?: Anchor): Promise<Comment> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Comment cannot be empty');
  }
  const comment = createComment('user', trimmed, parentId ? undefined : anchor);
  await appendComment(filePath, comment, parentId);
  toastStore.broadcast({ type: 'doc_comments_updated', docPath: filePath });
  let threadRootId = comment.id;
  if (parentId) {
    const all = await readComments(filePath);
    const root = findThreadRoot(all, parentId);
    if (root) {
      threadRootId = root.id;
    }
  }
  await dispatchMentions(filePath, comment, threadRootId);
  return comment;
}
