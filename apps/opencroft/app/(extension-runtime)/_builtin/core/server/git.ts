import host from '@ext/host';

import { type TerminalContext, terminalExec } from './terminal';

interface ResolvedHandle {
  value?: TerminalContext;
}

interface GitWorkspaceNodeData {
  folder?: string;
  __resolvedContexts?: Record<string, ResolvedHandle>;
}

interface ResolvedGitWorkspace {
  context: TerminalContext;
  folder: string;
}

async function resolveGitWorkspace(nodeId: string): Promise<ResolvedGitWorkspace> {
  const node = await host.graph.getNode(nodeId);
  if (!node) {
    throw new Error(`Git workspace node ${nodeId} not found`);
  }
  const data = node.data as GitWorkspaceNodeData;
  const context = data.__resolvedContexts?.['ctx-in']?.value;
  if (!context) {
    throw new Error('No terminal context connected');
  }
  if (!data.folder) {
    throw new Error('Workspace folder is not set');
  }
  return { context, folder: data.folder };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface GitListReposParams {
  nodeId: string;
}

export interface RepoInfo {
  name: string;
  branch: string;
  changes: number;
  ahead: number;
  behind: number;
}

export async function gitListRepos(params: GitListReposParams): Promise<RepoInfo[]> {
  const { context, folder } = await resolveGitWorkspace(params.nodeId);
  const root = shellQuote(folder);
  const script = [
    `cd ${root} 2>/dev/null || exit 0`,
    'for d in */; do',
    '  d="${d%/}"',
    '  if [ -d "$d/.git" ]; then',
    "    branch=$(git -c safe.directory='*' -C \"$d\" symbolic-ref --short HEAD 2>/dev/null || git -c safe.directory='*' -C \"$d\" rev-parse --short HEAD 2>/dev/null)",
    '    [ -n "$branch" ] || branch="?"',
    "    changes=$(git -c safe.directory='*' -C \"$d\" status --porcelain 2>/dev/null | awk 'END{print NR+0}')",
    "    track=$(git -c safe.directory='*' -C \"$d\" rev-list --left-right --count HEAD...@{upstream} 2>/dev/null)",
    '    ahead=$(printf "%s" "$track" | awk \'{print $1+0}\')',
    '    behind=$(printf "%s" "$track" | awk \'{print $2+0}\')',
    '    [ -n "$ahead" ] || ahead=0',
    '    [ -n "$behind" ] || behind=0',
    '    branch=$(printf "%s" "$branch" | tr -d "\\n\\t")',
    '    printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$d" "$branch" "$changes" "$ahead" "$behind"',
    '  fi',
    'done',
  ].join('\n');
  let out = '';
  try {
    out = await terminalExec(context, script);
  } catch (err) {
    console.error(`[git.listRepos] failed for ${params.nodeId}:`, err);
    return [];
  }
  if (!out.trim()) {
    return [];
  }
  return out.trim().split('\n').map((line) => {
    const [name, branch, changes, ahead, behind] = line.split('\t');
    return {
      name,
      branch: branch || '?',
      changes: Number(changes) || 0,
      ahead: Number(ahead) || 0,
      behind: Number(behind) || 0,
    };
  });
}

export interface GitCloneParams {
  nodeId: string;
  url: string;
}

export async function gitClone(params: GitCloneParams): Promise<void> {
  const { context, folder } = await resolveGitWorkspace(params.nodeId);
  const script = `mkdir -p ${shellQuote(folder)} && cd ${shellQuote(folder)} && git clone ${shellQuote(params.url)}`;
  await terminalExec(context, script);
}
