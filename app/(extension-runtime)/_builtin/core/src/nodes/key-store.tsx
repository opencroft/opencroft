import {
  React,
  NodeFrame,
  icons,
  invoke,
  toast,
} from '@ext/host';
import {
  Badge,
  Button,
  ControlledInput,
  Flex,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@ext/ui';

const { useCallback, useEffect, useRef, useState } = React;

interface KeyEntry {
  name: string; type: string; fingerprint: string; hasPublicKey: boolean; inWsl: boolean;
}
export interface KeyStoreData { keyNames: string[]; }

export function KeyStoreNode({ data, selected }: { data: KeyStoreData; selected?: boolean }) {
  const names = data.keyNames ?? [];
  return (
    <NodeFrame
      icon={icons.KeyRound}
      title='Key Store'
      subtitle={names.length > 0 ? `${names.length} keys` : 'empty'}
      selected={selected ?? false}
    >
      {names.length > 0 ? (
        <div className='flex flex-col gap-0.5 text-[10px] font-mono text-muted-foreground'>
          {names.slice(0, 5).map((n) => <div key={n}>{n}</div>)}
          {names.length > 5 ? <div>+{names.length - 5} more</div> : null}
        </div>
      ) : null}
    </NodeFrame>
  );
}

function KeyItem({
  entry, onCopyPublic, onDelete, onToggleWsl,
}: { entry: KeyEntry; onCopyPublic: () => void; onDelete: () => void; onToggleWsl: () => void }) {
  return (
    <div className='flex flex-col gap-1 rounded border p-2'>
      <div className='flex items-center gap-1.5'>
        <icons.KeyRound className='h-3 w-3 text-muted-foreground' />
        <span className='text-xs font-mono flex-1'>{entry.name}</span>
        <Badge variant='outline' className='text-[9px] h-4'>{entry.type}</Badge>
      </div>
      <div className='text-[10px] font-mono text-muted-foreground truncate'>{entry.fingerprint}</div>
      <div className='flex gap-1 mt-1'>
        {entry.hasPublicKey ? (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onCopyPublic}>
            <icons.Copy className='h-2.5 w-2.5 mr-0.5' /> Pub
          </Button>
        ) : null}
        {entry.inWsl ? (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onToggleWsl}>
            <icons.Check className='h-2.5 w-2.5 mr-0.5' /> WSL
          </Button>
        ) : (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onToggleWsl}>
            <icons.Upload className='h-2.5 w-2.5 mr-0.5' /> To WSL
          </Button>
        )}
        <Button
          variant='ghost' size='sm'
          className='h-5 text-[10px] px-1 ml-auto text-destructive'
          onClick={onDelete}
        >
          <icons.Trash2 className='h-2.5 w-2.5' />
        </Button>
      </div>
    </div>
  );
}

function ImportDropZone({ onImport }: { onImport: (name: string, content: string) => Promise<void> }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      const content = await file.text();
      await onImport(file.name, content);
    }
  }, [onImport]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const cls = 'flex flex-col items-center justify-center gap-1.5 rounded border-2 border-dashed p-4 cursor-pointer transition-colors '
    + (dragging
      ? 'border-primary bg-primary/5'
      : 'border-muted-foreground/30 hover:border-muted-foreground/50');

  return (
    <div
      className={cls}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <icons.Upload className='h-4 w-4 text-muted-foreground' />
      <p className='text-xs text-muted-foreground'>Drop key files or click to browse</p>
      <input
        ref={inputRef}
        type='file'
        className='hidden'
        multiple
        onChange={(e) => {
          if (e.target.files) {
            handleFiles(e.target.files);
          }
        }}
      />
    </div>
  );
}

export function KeyStoreInspector({
  nodeId, updateData,
}: { nodeId: string; data: KeyStoreData; updateData: (p: Partial<KeyStoreData>) => void }) {
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('ed25519');

  const load = useCallback(async () => {
    const list = await invoke<KeyEntry[]>('keyStore.listKeys', nodeId);
    setKeys(list);
    updateData({ keyNames: list.map((k) => k.name) });
  }, [nodeId, updateData]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) {
      return;
    }
    await invoke('keyStore.createKey', nodeId, newName.trim(), newType);
    setNewName('');
    await load();
    toast.success('Key created');
  }, [newName, newType, nodeId, load]);

  const handleImport = useCallback(async (name: string, content: string) => {
    await invoke('keyStore.importKey', nodeId, name, content);
    await load();
    toast.success(`Imported ${name}`);
  }, [nodeId, load]);

  const handleDelete = useCallback(async (name: string) => {
    await invoke('keyStore.deleteKey', nodeId, name);
    await load();
    toast.success('Key deleted');
  }, [nodeId, load]);

  const handleCopyPublic = useCallback(async (name: string) => {
    const pub = await invoke<string>('keyStore.readPublicKey', nodeId, name);
    await navigator.clipboard.writeText(pub.trim());
    toast.success('Public key copied');
  }, [nodeId]);

  const handleToggleWsl = useCallback(async (entry: KeyEntry) => {
    if (entry.inWsl) {
      await invoke('keyStore.removeKeyFromWsl', entry.name);
      toast.success(`Removed ${entry.name} from WSL`);
    } else {
      await invoke('keyStore.copyKeyToWsl', nodeId, entry.name);
      toast.success(`Copied ${entry.name} to WSL`);
    }
    await load();
  }, [nodeId, load]);

  return (
    <div className='flex flex-col gap-3'>
      <Flex row className='gap-1'>
        <ControlledInput
          value={newName}
          onValueChanged={setNewName}
          onAccepted={handleCreate}
          placeholder='Key name'
          className='flex-1 h-7 text-xs'
        />
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger className='h-7 text-xs w-24'><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value='ed25519'>Ed25519</SelectItem>
            <SelectItem value='rsa'>RSA</SelectItem>
            <SelectItem value='ecdsa'>ECDSA</SelectItem>
          </SelectContent>
        </Select>
        <Button size='sm' className='h-7 text-xs' onClick={handleCreate} disabled={!newName.trim()}>
          <icons.Plus className='h-3 w-3' />
        </Button>
      </Flex>
      <Separator />
      {keys.length > 0 ? (
        <Flex className='gap-1.5'>
          {keys.map((k) => (
            <KeyItem
              key={k.name}
              entry={k}
              onCopyPublic={() => handleCopyPublic(k.name)}
              onDelete={() => handleDelete(k.name)}
              onToggleWsl={() => handleToggleWsl(k)}
            />
          ))}
        </Flex>
      ) : (
        <div className='text-xs text-muted-foreground italic'>No keys yet</div>
      )}
      <ImportDropZone onImport={handleImport} />
    </div>
  );
}
