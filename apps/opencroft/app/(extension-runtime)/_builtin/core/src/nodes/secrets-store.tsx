import {
  React,
  NodeFrame,
  icons,
  invoke,
  toast,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
} from '@ext/ui';

const { useCallback, useEffect, useState } = React;

interface SecretRow {
  id?: string;
  key: string;
  value: string;
  updatedAt?: string;
  dirty: boolean;
}
export interface SecretsData { secretKeys: string[]; }

export function SecretsStoreNode({ data, selected }: { data: SecretsData; selected?: boolean }) {
  const keys = data.secretKeys ?? [];
  return (
    <NodeFrame
      icon={icons.ShieldCheck}
      title='Secrets Store'
      subtitle={keys.length > 0 ? `${keys.length} secrets` : 'empty'}
      selected={selected ?? false}
    >
      {keys.length > 0 ? (
        <div className='flex flex-col gap-0.5 text-[10px] font-mono'>
          {keys.slice(0, 5).map((k) => (
            <div key={k} className='flex justify-between'>
              <span>{k}</span>
              <span className='text-muted-foreground tracking-widest'>•••</span>
            </div>
          ))}
        </div>
      ) : null}
    </NodeFrame>
  );
}

function formatEditedAt(iso?: string): string {
  if (!iso) {
    return 'unsaved';
  }
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SecretRowEditorProps {
  row: SecretRow;
  onChange: (field: 'key' | 'value', v: string) => void;
  onRemove: () => void;
  onRotate: () => void;
}

function SecretRowEditor({ row, onChange, onRemove, onRotate }: SecretRowEditorProps) {
  const [visible, setVisible] = useState(false);
  const canRotate = Boolean(row.id) && !row.dirty;
  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex items-center gap-1'>
        <Input
          value={row.key}
          onChange={(e) => onChange('key', e.target.value)}
          placeholder='KEY'
          className='h-7 text-xs font-mono flex-1'
        />
        <Input
          value={row.value}
          onChange={(e) => onChange('value', e.target.value)}
          placeholder='value'
          type={visible ? 'text' : 'password'}
          className='h-7 text-xs font-mono flex-1'
        />
        <Button variant='ghost' size='icon' className='h-7 w-7' onClick={() => setVisible(!visible)}>
          {visible ? <icons.EyeOff className='h-3 w-3' /> : <icons.Eye className='h-3 w-3' />}
        </Button>
        <Button
          variant='ghost'
          size='icon'
          className='h-7 w-7'
          onClick={onRotate}
          disabled={!canRotate}
          title={canRotate ? 'Rotate token' : 'Save before rotating'}
        >
          <icons.RefreshCw className='h-3 w-3' />
        </Button>
        <Button variant='ghost' size='icon' className='h-7 w-7' onClick={onRemove}>
          <icons.Trash2 className='h-3 w-3' />
        </Button>
      </div>
      <div className='pl-1 text-[10px] text-muted-foreground'>
        edited {formatEditedAt(row.updatedAt)}
      </div>
    </div>
  );
}

interface OrphanRow { id: string; storeId: string; key: string; updatedAt: string; }

export function SecretsStoreInspector({
  nodeId, updateData,
}: { nodeId: string; data: SecretsData; updateData: (p: Partial<SecretsData>) => void }) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [orphans, setOrphans] = useState<OrphanRow[]>([]);

  const reload = useCallback(async () => {
    const secrets = await invoke<{ id: string; key: string; value: string; updatedAt: string }[]>(
      'secretsStore.getSecrets', nodeId,
    );
    setRows(secrets.map((s) => ({
      id: s.id, key: s.key, value: s.value, updatedAt: s.updatedAt, dirty: false,
    })));
    const found = await invoke<OrphanRow[]>('secretsStore.listOrphans', nodeId);
    setOrphans(found);
    setRemoved([]);
    setDirty(false);
  }, [nodeId]);

  const deleteOrphan = useCallback(async (id: string, key: string) => {
    if (!window.confirm(`Delete orphan secret "${key}"? It belongs to a Secrets Store node that no longer exists.`)) {
      return;
    }
    await invoke('secretsStore.deleteOrphan', id);
    await reload();
    toast.success(`Deleted orphan ${key}`);
  }, [reload]);

  useEffect(() => {
    reload();
  }, [reload]);

  const persist = useCallback(async () => {
    for (const key of removed) {
      await invoke('secretsStore.deleteSecret', nodeId, key);
    }
    for (const row of rows) {
      if (row.key && row.dirty) {
        await invoke('secretsStore.setSecret', nodeId, row.key, row.value);
      }
    }
    updateData({ secretKeys: rows.filter((r) => r.key).map((r) => r.key) });
    await reload();
    toast.success('Secrets saved');
  }, [rows, removed, nodeId, updateData, reload]);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { key: '', value: '', dirty: true }]);
    setDirty(true);
  }, []);

  const updateRow = useCallback((index: number, field: 'key' | 'value', v: string) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: v, dirty: true } : r)));
    setDirty(true);
  }, []);

  const removeRow = useCallback((index: number) => {
    setRows((prev) => {
      const row = prev[index];
      if (row.key) {
        setRemoved((r) => [...r, row.key]);
      }
      return prev.filter((_, i) => i !== index);
    });
    setDirty(true);
  }, []);

  const rotateRow = useCallback(async (index: number) => {
    const row = rows[index];
    if (!row?.id || row.dirty) {
      return;
    }
    const ok = window.confirm(
      `Rotate token for "${row.key}"?\n\nThe current value will be replaced with a new random token.`,
    );
    if (!ok) {
      return;
    }
    await invoke('secretsStore.rotateSecret', nodeId, row.key);
    await reload();
    toast.success(`Rotated ${row.key}`);
  }, [rows, nodeId, reload]);

  return (
    <div className='flex flex-col gap-3'>
      <Label className='text-xs'>Secrets</Label>
      <div className='flex flex-col gap-2'>
        {rows.map((r, i) => (
          <SecretRowEditor
            key={r.id ?? `new-${i}`}
            row={r}
            onChange={(field, v) => updateRow(i, field, v)}
            onRemove={() => removeRow(i)}
            onRotate={() => rotateRow(i)}
          />
        ))}
      </div>
      <div className='flex gap-1'>
        <Button variant='outline' size='sm' className='h-7 text-xs flex-1' onClick={addRow}>
          <icons.Plus className='h-3 w-3 mr-1' /> Add Secret
        </Button>
        <Button size='sm' className='h-7 text-xs' onClick={persist} disabled={!dirty}>
          Save
        </Button>
      </div>
      {orphans.length > 0 ? (
        <div className='flex flex-col gap-1 mt-3 pt-3 border-t'>
          <Label className='text-xs text-amber-600'>
            Orphan secrets ({orphans.length}) — from deleted stores
          </Label>
          <div className='text-[10px] text-muted-foreground'>
            These rows still live in the DB but no Secrets Store node owns them. They can shadow your active secrets at lookup time.
          </div>
          <div className='flex flex-col gap-0.5 mt-1'>
            {orphans.map((o) => (
              <div key={o.id} className='flex items-center gap-1 text-xs font-mono'>
                <span className='flex-1 truncate' title={`storeId: ${o.storeId}`}>{o.key}</span>
                <span className='text-[10px] text-muted-foreground'>
                  {formatEditedAt(o.updatedAt)}
                </span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-6 w-6'
                  onClick={() => deleteOrphan(o.id, o.key)}
                  title='Delete orphan row'
                >
                  <icons.Trash2 className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
