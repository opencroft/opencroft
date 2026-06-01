'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  type InstallAuth,
  installExtensionFromUrl,
  type InstalledExtensionRecord,
} from '@/app/(extension-editor)/_actions/installed-extensions-actions';
import {
  listSecretStores,
  type SecretStoreSummary,
} from '@/app/(secrets-store)/secrets-store/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface InstallExtensionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: (record: InstalledExtensionRecord) => void;
}

const NO_AUTH = '__none__';

export function InstallExtensionDialog({ open, onOpenChange, onInstalled }: InstallExtensionDialogProps) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [storeId, setStoreId] = useState<string>(NO_AUTH);
  const [stores, setStores] = useState<SecretStoreSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    listSecretStores().then(setStores).catch(() => setStores([]));
  }, [open]);

  function reset() {
    setUrl('');
    setRef('');
    setStoreId(NO_AUTH);
    setBusy(false);
  }

  async function submit() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      return;
    }
    setBusy(true);
    try {
      const auth: InstallAuth | undefined = storeId === NO_AUTH
        ? undefined
        : { type: 'secret', storeId };
      const record = await installExtensionFromUrl({
        data: {
          url: trimmedUrl,
          ref: ref.trim() || undefined,
          auth,
        },
      });
      toast.success(`Installed ${record.manifest.name ?? record.id} (${record.sidecar.ref})`);
      onInstalled(record);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) {
          return;
        }
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>Install extension from repository</DialogTitle>
          <DialogDescription>
            Clone a Git repository as an extension. Latest tag is used by default.
          </DialogDescription>
        </DialogHeader>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='install-url'>Repository</Label>
            <Input
              id='install-url'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleKey}
              placeholder='owner/repo or https://host/owner/repo'
              disabled={busy}
              autoFocus
            />
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='install-ref'>Tag or branch (optional)</Label>
            <Input
              id='install-ref'
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={handleKey}
              placeholder='Leave empty to install latest tag'
              disabled={busy}
            />
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='install-auth'>Authentication (private repos)</Label>
            <Select value={storeId} onValueChange={setStoreId} disabled={busy}>
              <SelectTrigger id='install-auth'>
                <SelectValue placeholder='None (public repo)' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_AUTH}>None (public repo)</SelectItem>
                {stores.map((store) => (
                  <SelectItem key={store.storeId} value={store.storeId}>
                    Secret {store.storeId.slice(-6)} ({store.keys.join(', ')})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className='text-[10px] text-muted-foreground'>
              Reads keys <code>token</code> (required) and <code>username</code> (optional, defaults to <code>x-access-token</code>) from the chosen Secrets Store.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant='ghost' onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !url.trim()}>
            {busy ? <Loader2 className='size-3.5 animate-spin' /> : null}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
