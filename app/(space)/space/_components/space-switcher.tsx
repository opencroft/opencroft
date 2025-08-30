'use client';

import { Download, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { SpaceExport, SpaceSummary } from '@/app/(space)/server/types';
import {
  createSpaceClient,
  deleteSpaceClient,
  importSpaceClient,
  listSpacesClient,
  renameSpaceClient,
} from '@/app/(space)/space/_components/space-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';

interface Props {
  slug: string;
  initialSpaces: SpaceSummary[];
}

export function SpaceSwitcher({ slug, initialSpaces }: Props) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceSummary[]>(initialSpaces);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const current = spaces.find((s) => s.slug === slug);

  useEffect(() => {
    setSpaces(initialSpaces);
  }, [initialSpaces]);

  async function refresh() {
    const list = await listSpacesClient();
    setSpaces(list);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      return;
    }
    const space = await createSpaceClient(name);
    setNewOpen(false);
    setNewName('');
    await refresh();
    router.push(`/space/${space.slug}`);
  }

  async function handleRename() {
    const name = renameValue.trim();
    if (!name || !current) {
      return;
    }
    await renameSpaceClient(current.slug, name);
    setRenameOpen(false);
    await refresh();
    router.refresh();
  }

  async function handleDelete() {
    if (!current) {
      return;
    }
    const remaining = spaces.filter((s) => s.slug !== current.slug);
    if (remaining.length === 0) {
      return;
    }
    const ok = await deleteSpaceClient(current.slug);
    if (!ok) {
      return;
    }
    router.push(`/space/${remaining[0].slug}`);
  }

  function handleExport() {
    if (!current) {
      return;
    }
    window.location.href = `/api/spaces/${encodeURIComponent(current.slug)}/export`;
  }

  function handleImportClick() {
    fileInput.current?.click();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    const text = await file.text();
    const payload = JSON.parse(text) as SpaceExport;
    const space = await importSpaceClient(payload);
    await refresh();
    router.push(`/space/${space.slug}`);
  }

  function openRename() {
    if (!current) {
      return;
    }
    setRenameValue(current.name);
    setRenameOpen(true);
  }

  return (
    <div className="flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="cursor-pointer bg-transparent text-lg font-semibold text-foreground outline-none [text-shadow:0_1px_2px_rgb(0_0_0/0.45)]"
          >
            {current?.name ?? 'Select space'}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[220px]">
          {spaces.map((s) => (
            <DropdownMenuItem key={s.slug} onSelect={() => router.push(`/space/${s.slug}`)}>
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openRename} disabled={!current}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setNewOpen(true)}>
            <Plus className="size-4" /> New
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleImportClick}>
            <Upload className="size-4" /> Import
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleExport} disabled={!current}>
            <Download className="size-4" /> Export
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={handleDelete}
            disabled={!current || spaces.length <= 1}
            variant="destructive"
          >
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInput}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={handleImportFile}
      />

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Space name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreate();
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename space</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRename();
              }
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={handleRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
