import host from '@ext/host';

// ─── Types ──────────────────────────────────────────────────────────────

interface DocumentationNodeData {
  name?: string;
  repoUrl: string;
  branch: string;
  secretId: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function slugFolder(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function docsCacheDir(nodeId: string): Promise<string> {
  let folder: string | null = null;
  try {
    const node = await host.graph.getNode(nodeId);
    const name = ((node?.data as DocumentationNodeData | undefined)?.name ?? '').trim();
    if (name) {
      const s = slugFolder(name);
      if (s) {
        folder = s;
      }
    }
  } catch {
    // fall back below
  }
  // If a name is set but the named path isn't cloned yet AND the legacy
  // nodeId-keyed path IS cloned, use the legacy path so existing clones
  // continue to work transparently across all operations (status, pull,
  // publish, etc.).
  if (folder !== null) {
    const named = host.cacheDir('docs', folder);
    if (await isCloned(named)) {
      return named;
    }
    const legacy = host.cacheDir('docs', nodeId);
    if (await isCloned(legacy)) {
      return legacy;
    }
    return named;
  }
  return host.cacheDir('docs', nodeId);
}

async function getNodeData(nodeId: string): Promise<DocumentationNodeData> {
  const node = await host.graph.getNode(nodeId);
  if (!node) {
    throw new Error(`Documentation node ${nodeId} not found`);
  }
  return node.data as DocumentationNodeData;
}

// NOTE: Uses host.prisma directly because host.secretsStore is not
// available in the current ExtensionHost API (see host.ts). This is
// functionally equivalent to the secretsStore actions in
// (secrets-store)/secrets-store/actions.ts.
async function resolveSecrets(secretId: string | null): Promise<{ username?: string; token?: string }> {
  if (!secretId) return {};
  try {
    const [usernameRow, tokenRow] = await Promise.all([
      host.prisma.secret.findUnique({
        where: { storeId_key: { storeId: secretId, key: 'username' } },
      }),
      host.prisma.secret.findUnique({
        where: { storeId_key: { storeId: secretId, key: 'token' } },
      }),
    ]);
    return {
      username: usernameRow ? host.crypto.decrypt(usernameRow.value as string) : undefined,
      token: tokenRow ? host.crypto.decrypt(tokenRow.value as string) : undefined,
    };
  } catch (err) {
    console.error('[docs-git] Failed to resolve secrets:', err);
    return {};
  }
}

function buildAuthUrl(repoUrl: string, username?: string, token?: string): string {
  if (!username || !token) return repoUrl;
  try {
    const url = new URL(repoUrl);
    url.username = username;
    url.password = token;
    return url.toString();
  } catch {
    // If URL parsing fails, return as-is
    return repoUrl;
  }
}

async function gitExec(repoDir: string, ...args: string[]): Promise<string> {
  return host.execFile('git', ['-c', 'safe.directory=*', '-C', repoDir, ...args]);
}

function isCloned(repoDir: string): Promise<boolean> {
  return host.fs.access(`${repoDir}/.git`)
    .then(() => true)
    .catch(() => false);
}

// ─── Public Actions ─────────────────────────────────────────────────────

export interface DocsStatusResult {
  status: 'idle' | 'cloned' | 'syncing' | 'error';
  changedFiles: number;
  path: string;
  error?: string;
}

export async function docsStatus(nodeId: string): Promise<DocsStatusResult> {
  const repoDir = await docsCacheDir(nodeId);
  const data = await getNodeData(nodeId);

  if (!data.repoUrl) {
    return { status: 'idle', changedFiles: 0, path: repoDir };
  }

  const cloned = await isCloned(repoDir);
  if (!cloned) {
    return { status: 'idle', changedFiles: 0, path: repoDir };
  }

  try {
    const output = await gitExec(repoDir, 'status', '--porcelain');
    const lines = output.trim().split('\n').filter(Boolean);
    return { status: 'cloned', changedFiles: lines.length, path: repoDir };
  } catch (err) {
    return {
      status: 'error',
      changedFiles: 0,
      path: repoDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function docsClone(nodeId: string): Promise<void> {
  const data = await getNodeData(nodeId);
  if (!data.repoUrl) {
    throw new Error('Repository URL is not set');
  }

  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (cloned) {
    throw new Error('Repository already cloned. Use Pull instead.');
  }

  const secrets = await resolveSecrets(data.secretId);
  const authUrl = buildAuthUrl(data.repoUrl, secrets.username, secrets.token);
  const branch = data.branch || 'main';

  await host.fs.mkdir(repoDir, { recursive: true });

  // Clean directory if not empty (e.g. leftover files without .git)
  const entries = await host.fs.readdir(repoDir);
  if (entries.length > 0) {
    await host.fs.rm(repoDir, { recursive: true });
    await host.fs.mkdir(repoDir, { recursive: true });
  }

  await host.execFile('git', [
    '-c', 'safe.directory=*',
    'clone',
    '--branch', branch,
    '--single-branch',
    authUrl,
    repoDir,
  ]);
}

export async function docsPull(nodeId: string): Promise<void> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  const data = await getNodeData(nodeId);
  const secrets = await resolveSecrets(data.secretId);

  // Set remote URL with auth for pull
  if (data.repoUrl && (secrets.username || secrets.token)) {
    const authUrl = buildAuthUrl(data.repoUrl, secrets.username, secrets.token);
    await gitExec(repoDir, 'remote', 'set-url', 'origin', authUrl);
  }

  await gitExec(repoDir, 'pull', '--rebase');
}

export interface DocsChangedFile {
  status: string;
  path: string;
}

export async function docsChangedFiles(nodeId: string): Promise<DocsChangedFile[]> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) return [];

  const output = await gitExec(repoDir, 'status', '--porcelain');
  return output.trim().split('\n').filter(Boolean).map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));
}

export interface DocsLogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export async function docsLog(nodeId: string, filePath?: string, count?: number): Promise<DocsLogEntry[]> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) return [];

  const limit = count ?? 50;
  const args = [
    'log',
    `--max-count=${limit}`,
    '--pretty=format:%H%x00%s%x00%an%x00%aI',
  ];
  if (filePath) {
    args.push('--', filePath);
  }

  const output = await gitExec(repoDir, ...args);
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const [sha, message, author, date] = line.split('\0');
    return { sha: sha ?? '', message: message ?? '', author: author ?? '', date: date ?? '' };
  });
}

export async function docsShow(nodeId: string, filePath: string, ref?: string): Promise<string> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  const gitRef = ref || 'HEAD';
  return gitExec(repoDir, 'show', `${gitRef}:${filePath}`);
}

/**
 * Commit and push a single file. Uses `git commit -- <path>` (the
 * --only form) so other staged changes in the index are not pulled
 * into this commit. The file is staged first to handle the
 * untracked-new-file case.
 */
export async function docsPublishFile(
  nodeId: string,
  filePath: string,
  message: string,
): Promise<{ sha: string; message: string }> {
  const repoDir = await docsCacheDir(nodeId);
  const data = await getNodeData(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  const secrets = await resolveSecrets(data.secretId);

  const gitUser = secrets.username || 'OpenCroft';
  await gitExec(repoDir, 'config', 'user.name', gitUser);
  await gitExec(repoDir, 'config', 'user.email', `${gitUser}@opencroft.local`);

  if (data.repoUrl && (secrets.username || secrets.token)) {
    const authUrl = buildAuthUrl(data.repoUrl, secrets.username, secrets.token);
    await gitExec(repoDir, 'remote', 'set-url', 'origin', authUrl);
  }

  await gitExec(repoDir, 'add', '--', filePath);
  await gitExec(repoDir, 'commit', '-m', message, '--', filePath);

  const branch = data.branch || 'main';
  await gitExec(repoDir, 'push', 'origin', branch);

  const sha = (await gitExec(repoDir, 'rev-parse', 'HEAD')).trim();

  return { sha, message };
}

export async function docsAddFile(nodeId: string, filePath: string): Promise<void> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) return;

  await gitExec(repoDir, 'add', filePath);
}

/**
 * Delete a doc and its sidecar files from the working tree, then commit
 * and push the deletion. For uncommitted-only files, the commit/push
 * step is skipped — the file just gets removed.
 */
export async function docsDeleteFile(nodeId: string, filePath: string): Promise<void> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  // Always remove the sidecar comments file (untracked, not in HEAD).
  await host.fs.rm(`${repoDir}/${filePath}.comments`).catch(() => {});

  const inHead = await fileInHead(repoDir, filePath);
  if (!inHead) {
    // Untracked / staged-new file — unstage if staged, then unlink.
    await gitExec(repoDir, 'rm', '--cached', '--ignore-unmatch', '--', filePath).catch(() => {});
    await host.fs.rm(`${repoDir}/${filePath}`).catch(() => {});
    return;
  }

  const data = await getNodeData(nodeId);
  const secrets = await resolveSecrets(data.secretId);
  const gitUser = secrets.username || 'OpenCroft';
  await gitExec(repoDir, 'config', 'user.name', gitUser);
  await gitExec(repoDir, 'config', 'user.email', `${gitUser}@opencroft.local`);
  if (data.repoUrl && (secrets.username || secrets.token)) {
    const authUrl = buildAuthUrl(data.repoUrl, secrets.username, secrets.token);
    await gitExec(repoDir, 'remote', 'set-url', 'origin', authUrl);
  }

  await gitExec(repoDir, 'rm', '--', filePath);
  await gitExec(repoDir, 'commit', '-m', `Delete ${filePath}`);
  const branch = data.branch || 'main';
  await gitExec(repoDir, 'push', 'origin', branch);
}

/**
 * Get the docs root directory for a documentation node.
 * Returns null if the node is not set up or not cloned.
 */
export async function getDocsRoot(nodeId: string): Promise<string | null> {
  if (!nodeId) return null;
  const repoDir = await docsCacheDir(nodeId);
  return (await isCloned(repoDir)) ? repoDir : null;
}

/**
 * Find the documentation node matching `namespace` (slugified data.name)
 * and return its docs root. If `namespace` is omitted, returns the root
 * of the first documentation node found.
 */
export async function findActiveDocsRoot(namespace?: string): Promise<string | null> {
  const nodeId = await findDocNodeId(namespace);
  if (!nodeId) return null;
  return getDocsRoot(nodeId);
}

interface NamespaceEntry {
  id: string;
  namespace: string;
  name: string;
}

/**
 * List every documentation node on the graph keyed by namespace slug.
 * Used by the sidebar / MCP discovery.
 */
export async function listDocNamespaces(): Promise<NamespaceEntry[]> {
  try {
    const nodes = await host.graph.listNodesByType('documentation');
    if (!nodes) return [];
    const out: NamespaceEntry[] = [];
    for (const n of nodes) {
      const data = (n as { data?: { name?: string } }).data ?? {};
      const name = (data.name ?? '').trim();
      const namespace = name ? slugFolder(name) : '';
      if (!namespace) continue;
      out.push({ id: (n as { id: string }).id, namespace, name });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Discard local changes for a file. Behaviour depends on whether the
 * file exists in HEAD:
 *  - In HEAD: revert working-tree to the committed version.
 *  - Not in HEAD (newly created): unstage if staged, then delete from
 *    the working tree.
 */
export async function docsDiscardFile(nodeId: string, filePath: string): Promise<void> {
  const repoDir = await docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }
  const inHead = await fileInHead(repoDir, filePath);
  if (inHead) {
    await gitExec(repoDir, 'checkout', '--', filePath);
    return;
  }
  // New (untracked or staged-new) file — unstage if staged, then unlink.
  try {
    await gitExec(repoDir, 'rm', '--cached', '--ignore-unmatch', '--', filePath);
  } catch {
    // Not staged — fine, fall through to unlink.
  }
  try {
    await host.fs.rm(`${repoDir}/${filePath}`);
  } catch {
    // Already gone — fine.
  }
}

async function fileInHead(repoDir: string, filePath: string): Promise<boolean> {
  try {
    await gitExec(repoDir, 'cat-file', '-e', `HEAD:${filePath}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the documentation node ID matching `namespace` (slugified data.name).
 * If `namespace` is omitted, returns the first documentation node found.
 */
export async function findDocNodeId(namespace?: string): Promise<string | null> {
  try {
    const nodes = await host.graph.listNodesByType('documentation');
    if (!nodes || nodes.length === 0) return null;
    if (!namespace) {
      return nodes[0].id;
    }
    for (const n of nodes) {
      const data = (n as { data?: { name?: string } }).data ?? {};
      const name = (data.name ?? '').trim();
      if (name && slugFolder(name) === namespace) {
        return (n as { id: string }).id;
      }
    }
    return null;
  } catch {
    return null;
  }
}
