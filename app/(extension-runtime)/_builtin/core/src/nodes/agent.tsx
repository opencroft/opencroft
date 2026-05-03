import {
  React,
  NodeFrame,
  InputHandle,
  icons,
  invoke,
  useGraphNodes,
  toast,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
  Badge,
  Separator,
  ScrollArea,
} from '@ext/ui';

const { useCallback, useRef, useState, useEffect, useMemo } = React;

export interface AgentData {
  name: string;
  avatar?: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

export function AgentNode({
  data, selected,
}: { id: string; data: AgentData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.User}
      title={data.name || 'Agent'}
      selected={selected ?? false}
    >
      <div className='flex flex-col gap-1.5'>
        <InputHandle type='agent-instruction' id='instructions-in'>
          <span className='text-[10px] text-muted-foreground'>Instructions</span>
        </InputHandle>
        <InputHandle type='agent-job' id='agent-in'>
          <span className='text-[10px] text-muted-foreground'>Jobs</span>
        </InputHandle>
      </div>
    </NodeFrame>
  );
}

export function AgentInspector({
  data, updateData,
}: { nodeId: string; data: AgentData; updateData: (p: Partial<AgentData>) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    const url = await readAsDataUrl(file);
    updateData({ avatar: url });
    e.target.value = '';
  }, [updateData]);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Avatar</Label>
        <div className='flex items-center gap-2'>
          <div className='h-12 w-12 rounded-full overflow-hidden bg-muted flex items-center justify-center shrink-0'>
            {data.avatar ? (
              <img src={data.avatar} alt='' className='h-full w-full object-cover' />
            ) : (
              <icons.User className='h-5 w-5 text-muted-foreground' />
            )}
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={() => inputRef.current?.click()}
          >
            <icons.Upload className='h-3 w-3 mr-1' />
            {data.avatar ? 'Change' : 'Upload'}
          </Button>
          {data.avatar ? (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => updateData({ avatar: undefined })}
            >
              <icons.Trash2 className='h-3 w-3' />
            </Button>
          ) : null}
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            className='hidden'
            onChange={handlePick}
          />
        </div>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Agent name'
        />
      </div>
    </div>
  );
}

// ─── OpenClaw Tab Types ──────────────────────────────────────────────

interface AgentInfo {
  agentId: string;
  name: string;
  isDefault: boolean;
  workspace?: string;
  exists: true;
}

interface AgentNotFound {
  exists: false;
}

type AgentLookup = AgentInfo | AgentNotFound;

interface ConnectionState {
  connected: boolean;
  reason?: string;
}

// ─── OpenClaw Tab Component ──────────────────────────────────────────

export function AgentOpenClawTab({
  data,
}: { nodeId: string; data: AgentData; updateData: (p: Partial<AgentData>) => void }) {
  const agentName = data.name?.trim() ?? '';
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [lookup, setLookup] = useState<AgentLookup | null>(null);
  const [externalAgents, setExternalAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('');

  // Auto-suggest workspace when agent name changes
  useEffect(() => {
    if (agentName) {
      setWorkspace(`~/.openclaw/workspace-${agentName}`);
    } else {
      setWorkspace('');
    }
  }, [agentName]);

  // Get all agent node names on the graph to compute external agents
  const graphNodes = useGraphNodes();
  const agentNodeNames = useMemo(() => {
    const names: string[] = [];
    for (const node of graphNodes) {
      if ((node as { type?: string }).type === 'agent') {
        const nodeData = (node as { data?: { name?: string } }).data;
        const name = nodeData?.name?.trim();
        if (name) {
          names.push(name);
        }
      }
    }
    return names;
  }, [graphNodes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      invoke<ConnectionState>('agent.getOpenclawConnection'),
      agentName
        ? invoke<AgentLookup>('agent.lookupOpenclaw', agentName)
        : Promise.resolve<AgentLookup>({ exists: false }),
      invoke<AgentInfo[]>('agent.listOpenclawExternal', agentNodeNames),
    ])
      .then(([conn, agentResult, external]) => {
        if (cancelled) return;
        setConnection(conn);
        setLookup(agentResult);
        setExternalAgents(external);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load OpenClaw data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [agentName, agentNodeNames]);

  const handleCreate = useCallback(async () => {
    if (!agentName) return;
    setCreating(true);
    setError(null);
    try {
      const result = await invoke<AgentLookup>('agent.createOpenclaw', agentName, workspace || undefined);
      if (result.exists) {
        setLookup(result);
        toast.success(`Agent "${result.name}" created in OpenClaw`);
      } else {
        setError('Agent creation returned no result. Check gateway logs.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create agent';
      setError(msg);
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }, [agentName, workspace]);

  const handleRefresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      invoke<AgentLookup>('agent.lookupOpenclaw', agentName),
      invoke<AgentInfo[]>('agent.listOpenclawExternal', agentNodeNames),
    ])
      .then(([agentResult, external]) => {
        setLookup(agentResult);
        setExternalAgents(external);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to refresh');
      })
      .finally(() => setLoading(false));
  }, [agentName, agentNodeNames]);

  // Not connected
  if (connection && !connection.connected) {
    return (
      <div className='flex flex-col gap-3 p-1'>
        <div className='flex items-center gap-2 text-muted-foreground'>
          <icons.WifiOff className='size-4' />
          <span className='text-xs'>Not connected</span>
        </div>
        <p className='text-xs text-muted-foreground'>
          {connection.reason || 'Configure the OpenClaw gateway in Settings → AI to connect your agents.'}
        </p>
      </div>
    );
  }

  // Loading state
  if (loading && !connection) {
    return (
      <div className='flex items-center justify-center py-8'>
        <icons.Loader2 className='size-5 animate-spin text-muted-foreground' />
      </div>
    );
  }

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        {/* Connection status */}
        <div className='flex items-center gap-2'>
          <div className='size-2 rounded-full bg-green-500 shrink-0' />
          <span className='text-xs text-muted-foreground'>Connected to OpenClaw</span>
          <div className='flex-1' />
          <Button variant='ghost' size='sm' className='size-6 p-0' onClick={handleRefresh} disabled={loading}>
            <icons.RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <Separator />

        {/* Agent lookup result */}
        {!agentName ? (
          <p className='text-xs text-muted-foreground italic'>
            Set an agent name in the Details tab first.
          </p>
        ) : lookup?.exists ? (
          <AgentInfoCard agent={lookup} />
        ) : (
          <AgentCreateCard
            agentName={agentName}
            workspace={workspace}
            onWorkspaceChange={setWorkspace}
            creating={creating}
            onCreate={handleCreate}
          />
        )}

        {/* Error display */}
        {error && (
          <p className='text-xs text-destructive'>{error}</p>
        )}

        {/* External agents section */}
        {externalAgents.length > 0 && (
          <>
            <Separator />
            <div className='flex items-center gap-2'>
              <icons.Globe className='size-3.5 text-muted-foreground' />
              <span className='text-xs font-medium'>External Agents</span>
              <Badge variant='secondary' className='text-[10px] px-1.5 py-0'>
                {externalAgents.length}
              </Badge>
            </div>
            <p className='text-[10px] text-muted-foreground'>
              Agents in OpenClaw not registered via any Agent node.
            </p>
            <div className='flex flex-col gap-1'>
              {externalAgents.map((ext) => (
                <ExternalAgentCard key={ext.agentId} agent={ext} />
              ))}
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function AgentInfoCard({ agent }: { agent: AgentInfo }) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2'>
        <div className='size-2 rounded-full bg-green-500 shrink-0' />
        <span className='text-xs font-medium'>Agent registered</span>
        {agent.isDefault && (
          <Badge variant='outline' className='text-[10px] px-1.5 py-0'>
            default
          </Badge>
        )}
      </div>
      <div className='rounded-md border p-2.5 flex flex-col gap-1.5'>
        <InfoRow icon={<icons.Hash className='size-3' />} label='ID' value={agent.agentId} />
        <InfoRow icon={<icons.User className='size-3' />} label='Name' value={agent.name} />
        {agent.workspace && (
          <InfoRow icon={<icons.Folder className='size-3' />} label='Path' value={agent.workspace} />
        )}
      </div>
    </div>
  );
}

function ExternalAgentCard({ agent }: { agent: AgentInfo }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className='rounded-md border'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex items-center gap-2 w-full px-2.5 py-1.5 text-left hover:bg-accent/50 transition-colors rounded-md'
      >
        <icons.User className='size-3.5 text-muted-foreground shrink-0' />
        <span className='text-xs flex-1 truncate'>{agent.name}</span>
        {agent.isDefault && (
          <Badge variant='outline' className='text-[10px] px-1.5 py-0'>
            default
          </Badge>
        )}
        <icons.ChevronRight className={`size-3 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className='px-2.5 pb-2 pt-0 flex flex-col gap-1 border-t'>
          <InfoRow icon={<icons.Hash className='size-3' />} label='ID' value={agent.agentId} />
          {agent.workspace && (
            <InfoRow icon={<icons.Folder className='size-3' />} label='Path' value={agent.workspace} />
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className='flex items-center gap-2'>
      <span className='text-muted-foreground'>{icon}</span>
      <span className='text-[10px] text-muted-foreground uppercase tracking-wide w-10'>{label}</span>
      <span className='text-xs font-mono truncate flex-1' title={value}>{value}</span>
    </div>
  );
}

function AgentCreateCard({
  agentName,
  workspace,
  onWorkspaceChange,
  creating,
  onCreate,
}: {
  agentName: string;
  workspace: string;
  onWorkspaceChange: (v: string) => void;
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2'>
        <div className='size-2 rounded-full bg-yellow-500 shrink-0' />
        <span className='text-xs font-medium'>Not found in OpenClaw</span>
      </div>
      <p className='text-xs text-muted-foreground'>
        No agent named &ldquo;{agentName}&rdquo; exists in OpenClaw. Create one to enable chat sessions from this node.
      </p>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Workspace</Label>
        <Input
          value={workspace}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onWorkspaceChange(e.target.value)}
          placeholder='~/.openclaw/workspace-name'
          className='text-xs font-mono'
        />
        <p className='text-[10px] text-muted-foreground'>
          Directory for agent files (AGENTS.md, MEMORY.md, etc.)
        </p>
      </div>
      <Button
        variant='outline'
        size='sm'
        onClick={onCreate}
        disabled={creating}
        className='w-full'
      >
        {creating ? (
          <>
            <icons.Loader2 className='size-3 mr-1 animate-spin' />
            Creating…
          </>
        ) : (
          <>
            <icons.Plus className='size-3 mr-1' />
            Create &ldquo;{agentName}&rdquo; in OpenClaw
          </>
        )}
      </Button>
    </div>
  );
}
