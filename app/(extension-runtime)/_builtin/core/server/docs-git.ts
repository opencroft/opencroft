import host from '@ext/host';

// ─── Types ──────────────────────────────────────────────────────────────

interface DocumentationNodeData {
  repoUrl: string;
  branch: string;
  secretId: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function docsCacheDir(nodeId: string): string {
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
  const repoDir = docsCacheDir(nodeId);
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

  const repoDir = docsCacheDir(nodeId);
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
  const repoDir = docsCacheDir(nodeId);
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
  const repoDir = docsCacheDir(nodeId);
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
  const repoDir = docsCacheDir(nodeId);
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
  const repoDir = docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  const gitRef = ref || 'HEAD';
  return gitExec(repoDir, 'show', `${gitRef}:${filePath}`);
}

export async function docsPublish(nodeId: string, message: string): Promise<{ sha: string; message: string }> {
  const repoDir = docsCacheDir(nodeId);
  const data = await getNodeData(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }

  const secrets = await resolveSecrets(data.secretId);

  // Configure git user
  const gitUser = secrets.username || 'OpenCroft';
  await gitExec(repoDir, 'config', 'user.name', gitUser);
  await gitExec(repoDir, 'config', 'user.email', `${gitUser}@opencroft.local`);

  // Set remote URL with auth for push
  if (data.repoUrl && (secrets.username || secrets.token)) {
    const authUrl = buildAuthUrl(data.repoUrl, secrets.username, secrets.token);
    await gitExec(repoDir, 'remote', 'set-url', 'origin', authUrl);
  }

  // Stage all changes
  await gitExec(repoDir, 'add', '-A');

  // Commit
  await gitExec(repoDir, 'commit', '-m', message);

  // Push
  const branch = data.branch || 'main';
  await gitExec(repoDir, 'push', 'origin', branch);

  // Get commit SHA
  const sha = (await gitExec(repoDir, 'rev-parse', 'HEAD')).trim();

  return { sha, message };
}

export async function docsAddFile(nodeId: string, filePath: string): Promise<void> {
  const repoDir = docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) return;

  await gitExec(repoDir, 'add', filePath);
}

/**
 * Get the docs root directory for a documentation node.
 * Returns null if the node is not set up or not cloned.
 */
export async function getDocsRoot(nodeId: string): Promise<string | null> {
  if (!nodeId) return null;
  const repoDir = docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  return cloned ? repoDir : null;
}

/**
 * Find the first documentation node on the graph and return its docs root.
 */
export async function findActiveDocsRoot(): Promise<string | null> {
  try {
    const nodes = await host.graph.listNodesByType('documentation');
    if (!nodes || nodes.length === 0) return null;

    // Use first documentation node found
    const node = nodes[0];
    return getDocsRoot(node.id);
  } catch {
    return null;
  }
}

/** Discard changes for a file, reverting to the last committed version. */
export async function docsDiscardFile(nodeId: string, filePath: string): Promise<void> {
  const repoDir = docsCacheDir(nodeId);
  const cloned = await isCloned(repoDir);
  if (!cloned) {
    throw new Error('Repository is not cloned');
  }
  await host.execFile('git', ['-c', 'safe.directory=*', '-C', repoDir, 'checkout', '--', filePath]);
}

/** Find the first documentation node ID on the graph. */
export async function findDocNodeId(): Promise<string | null> {
  try {
    const nodes = await host.graph.listNodesByType('documentation');
    if (!nodes || nodes.length === 0) return null;
    return nodes[0].id;
  } catch {
    return null;
  }
}
