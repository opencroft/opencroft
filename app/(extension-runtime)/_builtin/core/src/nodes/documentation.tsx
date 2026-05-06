import {
  React,
  NodeFrame,
  icons,
  invoke,
  toast,
  useGraphNodes,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
  Badge,
  Separator,
  ScrollArea,
} from '@ext/ui';

const { useCallback, useEffect, useState } = React;

// ─── Types ──────────────────────────────────────────────────────────────

export interface DocumentationData {
  name: string;
  repoUrl: string;
  branch: string;
  secretId: string | null;
}

type CloneStatus = 'idle' | 'cloned' | 'syncing' | 'error';

interface DocStatusResult {
  status: CloneStatus;
  changedFiles: number;
  path: string;
  error?: string;
}

interface LogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
}

// ─── Node Component ─────────────────────────────────────────────────────

export function DocumentationNode({
  id, data, selected,
}: { id: string; data: DocumentationData; selected?: boolean }) {
  const [status, setStatus] = useState<CloneStatus>('idle');
  const [changedFiles, setChangedFiles] = useState(0);

  useEffect(() => {
    if (!data.repoUrl) {
      setStatus('idle');
      return;
    }
    invoke<DocStatusResult>('docs.status', { nodeId: id })
      .then((result) => {
        setStatus(result.status);
        setChangedFiles(result.changedFiles);
      })
      .catch(() => setStatus('error'));
  }, [id, data.repoUrl]);

  const statusColor =
    status === 'cloned' ? 'bg-green-500' :
    status === 'syncing' ? 'bg-yellow-500' :
    status === 'error' ? 'bg-red-500' :
    'bg-muted-foreground';

  const repoLabel = data.repoUrl
    ? data.repoUrl.replace(/\.git$/, '').split('/').slice(-2).join('/')
    : 'no repository';
  const title = (data.name ?? '').trim() || 'Documentation';

  return (
    <NodeFrame
      icon={icons.BookOpen}
      title={title}
      subtitle={repoLabel}
      status={status === 'cloned' ? 'success' : status === 'error' ? 'warning' : 'neutral'}
      selected={selected ?? false}
    >
      <div className='flex items-center gap-1.5 text-[10px] text-muted-foreground'>
        <div className={`h-2 w-2 rounded-full ${statusColor} shrink-0`} />
        <span className='truncate'>
          {status === 'idle' ? 'Not connected' :
           status === 'cloned' ? `Cloned${changedFiles > 0 ? ` · ${changedFiles} changes` : ''}` :
           status === 'syncing' ? 'Syncing…' :
           status === 'error' ? 'Error' : '—'}
        </span>
      </div>
    </NodeFrame>
  );
}

// ─── Inspector: Details Tab ─────────────────────────────────────────────

export function DocumentationDetailsTab({
  nodeId, data, updateData,
}: {
  nodeId: string;
  data: DocumentationData;
  updateData: (p: Partial<DocumentationData>) => void;
}) {
  const [status, setStatus] = useState<DocStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'clone' | 'pull' | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<DocStatusResult>('docs.status', { nodeId });
      setStatus(result);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleClone = useCallback(async () => {
    if (!data.repoUrl) {
      toast.error('Repository URL is required');
      return;
    }
    setBusy('clone');
    try {
      await invoke<void>('docs.clone', { nodeId });
      toast.success('Repository cloned');
      refresh();
    } catch (err) {
      toast.error(`Clone failed: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [nodeId, data.repoUrl, refresh]);

  const handlePull = useCallback(async () => {
    setBusy('pull');
    try {
      await invoke<void>('docs.pull', { nodeId });
      toast.success('Repository pulled');
      refresh();
    } catch (err) {
      toast.error(`Pull failed: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [nodeId, refresh]);

  const statusColor =
    status?.status === 'cloned' ? 'bg-green-500' :
    status?.status === 'error' ? 'bg-red-500' :
    status?.status === 'syncing' ? 'bg-yellow-500' :
    'bg-muted-foreground';

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <div className='flex flex-col gap-1'>
          <Label>Name</Label>
          <Input
            value={data.name ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
            placeholder='opencroft-docs'
          />
          <p className='text-[10px] text-muted-foreground'>
            Used as the cache folder name and shown in the sidebar.
          </p>
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Repository URL</Label>
          <Input
            value={data.repoUrl ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ repoUrl: e.target.value })}
            placeholder='https://github.com/user/docs.git'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Branch</Label>
          <Input
            value={data.branch ?? 'main'}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ branch: e.target.value })}
            placeholder='main'
          />
        </div>

        <Separator />

        {/* Status */}
        <div className='flex items-center gap-2'>
          <div className={`size-2 rounded-full ${statusColor} shrink-0`} />
          <span className='text-xs text-muted-foreground'>
            {status?.status === 'cloned' ? 'Cloned' :
             status?.status === 'error' ? 'Error' :
             status?.status === 'syncing' ? 'Syncing' :
             status?.status === 'idle' ? 'Not cloned' : '—'}
          </span>
          {status?.changedFiles ? (
            <Badge variant='secondary' className='text-[10px] px-1.5 py-0'>
              {status.changedFiles} changes
            </Badge>
          ) : null}
          <div className='flex-1' />
          <Button variant='ghost' size='sm' className='size-6 p-0' onClick={refresh} disabled={loading}>
            <icons.RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {status?.path && (
          <div className='rounded-md border p-2 text-[10px] font-mono text-muted-foreground break-all'>
            {status.path}
          </div>
        )}

        {status?.error && (
          <p className='text-xs text-destructive'>{status.error}</p>
        )}

        <Separator />

        {/* Actions */}
        <div className='flex gap-2'>
          <Button
            variant='outline'
            size='sm'
            className='flex-1'
            onClick={handleClone}
            disabled={busy !== null || !data.repoUrl}
          >
            {busy === 'clone' ? <icons.Loader2 className='size-3 mr-1 animate-spin' /> : <icons.Download className='size-3 mr-1' />}
            Clone
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='flex-1'
            onClick={handlePull}
            disabled={busy !== null || status?.status !== 'cloned'}
          >
            {busy === 'pull' ? <icons.Loader2 className='size-3 mr-1 animate-spin' /> : <icons.ArrowDown className='size-3 mr-1' />}
            Pull
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

// ─── Inspector: Keys Tab ────────────────────────────────────────────────

interface SecretsStoreNode {
  id: string;
  type?: string;
  data: { secretKeys?: string[] };
}

export function DocumentationKeysTab({
  data, updateData,
}: {
  nodeId: string;
  data: DocumentationData;
  updateData: (p: Partial<DocumentationData>) => void;
}) {
  const graphNodes = useGraphNodes();
  const secretsStores = graphNodes.filter(
    (n) => (n as { type?: string }).type === 'core-secrets-store'
  ) as unknown as SecretsStoreNode[];

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <div className='flex flex-col gap-1'>
          <Label>Secrets Store</Label>
          <p className='text-[10px] text-muted-foreground'>
            Select a Secrets Store for git authentication (username/token).
          </p>
        </div>

        {secretsStores.length === 0 ? (
          <div className='text-xs text-muted-foreground italic'>
            No Secrets Store nodes on the graph. Add one to provide git credentials.
          </div>
        ) : (
          <div className='flex flex-col gap-1'>
            {secretsStores.map((store) => {
              const keys = store.data.secretKeys ?? [];
              const selected = data.secretId === store.id;
              return (
                <button
                  key={store.id}
                  type='button'
                  onClick={() => updateData({ secretId: selected ? null : store.id })}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-md border text-left transition-colors ${
                    selected ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
                  }`}
                >
                  <icons.ShieldCheck className='size-4 shrink-0 text-muted-foreground' />
                  <div className='flex-1 min-w-0'>
                    <div className='text-xs font-medium truncate'>
                      Secrets Store {store.id.slice(-6)}
                    </div>
                    <div className='text-[10px] text-muted-foreground'>
                      {keys.length > 0 ? keys.join(', ') : 'empty'}
                    </div>
                  </div>
                  {selected && (
                    <icons.Check className='size-3.5 text-primary shrink-0' />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {data.secretId && (
          <>
            <Separator />
            <div className='text-[10px] text-muted-foreground'>
              <p>The Documentation node will look for these keys in the selected store:</p>
              <ul className='mt-1 ml-3 list-disc'>
                <li><code className='font-mono'>username</code> — git username</li>
                <li><code className='font-mono'>token</code> — git password/token</li>
              </ul>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
