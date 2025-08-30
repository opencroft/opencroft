'use client';

import { type Node, type NodeProps } from '@xyflow/react';
import { Eye, EyeOff, ShieldCheck, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { type NodeSettingsProps, type NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/app-dashboard/registry';
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(legacy-app-dashboard)/nodes/shared/node-card';
import { deleteSecret, getSecrets, setSecret } from '@/app/(secrets-store)/secrets-store/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type SecretsStoreData = {
  secretKeys: string[];
};

export type SecretsStoreNode = Node<SecretsStoreData, 'secrets-store'>;

function SecretsStoreComponent({ data, selected }: NodeProps<SecretsStoreNode>) {
  const keys = data.secretKeys ?? [];

  return (
    <NodeCard selected={selected} accent="oklch(0.75 0.18 160)">
      <NodeCardHeader
        icon={ShieldCheck}
        iconClassName="text-emerald-400"
        title="Secrets Store"
        extra={<span className="text-[10px] text-muted-foreground tabular-nums">{keys.length}</span>}
      />
      {keys.length > 0 && (
        <NodeCardContent>
          <div className="flex flex-col gap-0.5">
            {keys.map((k, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="font-mono text-foreground/80">{k}</span>
                <span className="text-muted-foreground tracking-widest">•••</span>
              </div>
            ))}
          </div>
        </NodeCardContent>
      )}
    </NodeCard>
  );
}

interface SecretRow {
  key: string;
  value: string;
  dirty: boolean;
}

function SecretRowEditor({ row, onChange, onRemove }: {
  row: SecretRow;
  onChange: (field: 'key' | 'value', val: string) => void;
  onRemove: () => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex items-center gap-1">
      <Input
        value={row.key}
        onChange={(e) => onChange('key', e.target.value)}
        placeholder="KEY"
        autoComplete="one-time-code"
        className="h-7 text-xs font-mono flex-1"
      />
      <Input
        value={row.value}
        onChange={(e) => onChange('value', e.target.value)}
        placeholder="value"
        autoComplete="one-time-code"
        data-1p-ignore
        className={`h-7 text-xs font-mono flex-1 ${visible ? '' : '[&]:[-webkit-text-security:disc]'}`}
      />
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove}>
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

function SecretsStoreSettings({ id, updateData, onDirtyChange, onLoadingChange }: NodeSettingsProps<SecretsStoreData>) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onLoadingChange(true);
    getSecrets(id).then((secrets) => {
      setRows(secrets.map((s) => ({ key: s.key, value: s.value, dirty: false })));
      setRemoved([]);
      setDirty(false);
      onLoadingChange(false);
    });
  }, [id]);

  useEffect(() => {
    onDirtyChange(dirty, async () => {
      for (const key of removed) {
        await deleteSecret(id, key);
      }
      for (const row of rows) {
        if (row.key && row.dirty) {
          await setSecret(id, row.key, row.value);
        }
      }
      setRemoved([]);
      setRows((prev) => prev.filter((r) => r.key).map((r) => ({ ...r, dirty: false })));
      setDirty(false);
      updateData({ secretKeys: rows.filter((r) => r.key).map((r) => r.key) });
    });
  }, [dirty, rows, removed, id, updateData, onDirtyChange]);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { key: '', value: '', dirty: true }]);
    setDirty(true);
  }, []);

  const updateRow = useCallback((index: number, field: 'key' | 'value', val: string) => {
    setRows((prev) => prev.map((r, i) => i === index ? { ...r, [field]: val, dirty: true } : r));
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

  return (
    <div className="flex flex-col gap-3">
      <Label className="text-xs">Secrets</Label>
      <div className="flex flex-col gap-1">
        {rows.map((r, i) => (
          <SecretRowEditor
            key={i}
            row={r}
            onChange={(field, val) => updateRow(i, field, val)}
            onRemove={() => removeRow(i)}
          />
        ))}
      </div>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addRow}>
        <Plus className="h-3 w-3 mr-1" /> Add Secret
      </Button>
    </div>
  );
}

export const secretsStoreDefinition: NodeTypeDefinition<SecretsStoreData> = {
  type: 'secrets-store',
  label: 'Secrets Store',
  icon: ShieldCheck,
  group: 'Storage',
  defaultData: () => ({ secretKeys: [] }),
  component: SecretsStoreComponent,
  settings: SecretsStoreSettings,
};
