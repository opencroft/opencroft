import {
  React,
  NodeFrame,
  InputHandle,
  icons,
  invoke,
  toast,
  useNodeContext,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
  Separator,
} from '@ext/ui';

const { useCallback, useEffect, useState } = React;

export interface GitWorkspaceData {
  folder: string;
}

interface TerminalContext {
  type: string;
  [key: string]: unknown;
}

interface RepoInfo {
  name: string;
  branch: string;
  changes: number;
  ahead: number;
  behind: number;
}

export function GitWorkspaceNode({
  id, data, selected,
}: { id: string; data: GitWorkspaceData; selected?: boolean }) {
  const ctx = useNodeContext<TerminalContext>(id, 'ctx-in');
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!ctx?.value || !data.folder) {
      setCount(null);
      return;
    }
    invoke<RepoInfo[]>('git.listRepos', { nodeId: id })
      .then((list) => setCount(list.length))
      .catch(() => setCount(null));
  }, [id, ctx?.value, data.folder]);

  const status = !ctx?.value ? 'warning' : count === null ? 'neutral' : 'success';
  const subtitle = data.folder || 'no folder';

  return (
    <NodeFrame
      icon={icons.GitBranch}
      title='Git Workspace'
      subtitle={subtitle}
      status={status}
      selected={selected ?? false}
      input={<InputHandle type='terminal-context' id='ctx-in' />}
    >
      <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
        <icons.FolderGit2 className='h-2.5 w-2.5 shrink-0' />
        <span className='truncate'>
          {count === null ? '—' : `${count} repo${count === 1 ? '' : 's'}`}
        </span>
      </div>
    </NodeFrame>
  );
}

interface CloneSectionProps {
  nodeId: string;
  ready: boolean;
  onCloned: () => void;
}

function CloneSection({ nodeId, ready, onCloned }: CloneSectionProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!url.trim()) {
      return;
    }
    setBusy(true);
    try {
      await invoke<void>('git.clone', { nodeId, url: url.trim() });
      setUrl('');
      onCloned();
      toast.success('Repository cloned');
    } catch (err) {
      toast.error(`Clone failed: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [nodeId, url, onCloned]);

  return (
    <div className='flex flex-col gap-1.5'>
      <Label>Clone</Label>
      <div className='flex gap-1.5'>
        <Input
          value={url}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
          placeholder='https://github.com/user/repo.git'
          className='h-7 text-xs'
        />
        <Button
          size='sm'
          className='h-7 text-xs'
          onClick={submit}
          disabled={!ready || busy || !url.trim()}
        >
          {busy ? <icons.Loader2 className='h-3 w-3 animate-spin' /> : <icons.Download className='h-3 w-3' />}
        </Button>
      </div>
    </div>
  );
}

interface RepoListProps {
  items: RepoInfo[] | null;
  loading: boolean;
  onRefresh: () => void;
}

function RepoList({ items, loading, onRefresh }: RepoListProps) {
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-2'>
        <Label className='flex-1'>Repositories</Label>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 text-[10px] px-1.5'
          onClick={onRefresh}
          disabled={loading}
        >
          <icons.RotateCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {items && items.length > 0 ? (
        <div className='flex flex-col divide-y rounded border'>
          {items.map((repo) => (
            <div key={repo.name} className='flex flex-col gap-0.5 px-2 py-1.5 text-xs'>
              <div className='flex items-center gap-1.5'>
                <icons.FolderGit2 className='h-3 w-3 shrink-0 text-muted-foreground' />
                <span className='font-medium truncate flex-1'>{repo.name}</span>
              </div>
              <div className='flex gap-3 text-[10px] text-muted-foreground'>
                <span className='flex items-center gap-1'>
                  <icons.GitBranch className='h-2.5 w-2.5' />
                  Branch {repo.branch}
                </span>
                {repo.ahead > 0 ? (
                  <span className='flex items-center gap-0.5'>
                    <icons.ArrowUp className='h-2.5 w-2.5' />
                    {repo.ahead}
                  </span>
                ) : null}
                {repo.behind > 0 ? (
                  <span className='flex items-center gap-0.5'>
                    <icons.ArrowDown className='h-2.5 w-2.5' />
                    {repo.behind}
                  </span>
                ) : null}
                <span className='flex items-center gap-1'>
                  <icons.FilePen className='h-2.5 w-2.5' />
                  Local Changes {repo.changes}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : items ? (
        <div className='text-[11px] text-muted-foreground italic'>No repositories.</div>
      ) : null}
    </div>
  );
}

export function GitWorkspaceInspector({
  nodeId, data, updateData,
}: { nodeId: string; data: GitWorkspaceData; updateData: (p: Partial<GitWorkspaceData>) => void }) {
  const ctx = useNodeContext<TerminalContext>(nodeId, 'ctx-in');
  const ready = Boolean(ctx?.value && data.folder);
  const [items, setItems] = useState<RepoInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!ready) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await invoke<RepoInfo[]>('git.listRepos', { nodeId });
      setItems(list);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [nodeId, ready]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Workspace folder</Label>
        <Input
          value={data.folder ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ folder: e.target.value })}
          placeholder='/home/user/workspace'
        />
      </div>
      <Separator />
      <CloneSection nodeId={nodeId} ready={ready} onCloned={refresh} />
      <Separator />
      {!ctx?.value ? (
        <div className='text-[11px] text-muted-foreground italic'>
          Connect a terminal context to inspect repositories.
        </div>
      ) : !data.folder ? (
        <div className='text-[11px] text-muted-foreground italic'>
          Set a workspace folder to inspect repositories.
        </div>
      ) : (
        <RepoList items={items} loading={loading} onRefresh={refresh} />
      )}
    </div>
  );
}
