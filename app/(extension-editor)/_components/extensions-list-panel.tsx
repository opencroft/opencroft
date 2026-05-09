'use client';

import { ArrowDownToLine, Box, Download, Plus, RefreshCw, Trash2 } from 'lucide-react';

import {
  type InstalledExtensionRecord,
  type UpdateCheck,
} from '@/app/(extension-editor)/_actions/installed-extensions-actions';
import { type LocalExtensionRecord } from '@/app/(extension-editor)/_actions/local-extensions-actions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface ExtensionsListPanelProps {
  records: LocalExtensionRecord[];
  installed: InstalledExtensionRecord[];
  updateChecks: Record<string, UpdateCheck>;
  selectedId: string | null;
  onSelect: (extensionId: string) => void;
  onNew: () => void;
  onInstall: () => void;
  onDelete: (extensionId: string) => void;
  onUpdate: (extensionId: string) => void;
  onUninstall: (extensionId: string) => void;
}

export function ExtensionsListPanel({
  records,
  installed,
  updateChecks,
  selectedId,
  onSelect,
  onNew,
  onInstall,
  onDelete,
  onUpdate,
  onUninstall,
}: ExtensionsListPanelProps) {
  return (
    <aside className='w-60 h-full border-r bg-card flex flex-col shrink-0'>
      <div className='flex items-center gap-1 p-3'>
        <span className='text-sm font-semibold flex-1'>Extensions</span>
        <Button size='icon' variant='ghost' className='size-6' onClick={onInstall} title='Install from repository'>
          <Download className='size-3.5' />
        </Button>
        <Button size='icon' variant='ghost' className='size-6' onClick={onNew} title='New local extension'>
          <Plus className='size-3.5' />
        </Button>
      </div>
      <Separator />
      <ScrollArea className='flex-1 min-h-0'>
        {records.length > 0 ? (
          <div>
            <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>
              Local
            </div>
            {records.map((record) => {
              const isSelected = selectedId === record.id;
              return (
                <div
                  key={record.id}
                  className={cn(
                    'group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
                    isSelected && 'bg-accent/60',
                  )}
                >
                  <button
                    onClick={() => onSelect(record.id)}
                    className='flex-1 flex items-center gap-2 text-left min-w-0'
                  >
                    <Box className='size-3.5 shrink-0' />
                    <span className='truncate'>{record.manifest.name}</span>
                  </button>
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive'
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(record.id);
                    }}
                    title='Delete extension'
                  >
                    <Trash2 className='size-3' />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
        {installed.length > 0 ? (
          <div>
            <div className='px-3 pt-3 text-[10px] uppercase tracking-wider text-muted-foreground'>
              Installed
            </div>
            {installed.map((record) => {
              const isSelected = selectedId === record.id;
              const check = updateChecks[record.id];
              const hasUpdate = check?.hasUpdate ?? false;
              return (
                <div
                  key={record.id}
                  className={cn(
                    'group flex items-center px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors',
                    isSelected && 'bg-accent/60',
                  )}
                >
                  <button
                    onClick={() => onSelect(record.id)}
                    className='flex-1 flex items-center gap-2 text-left min-w-0'
                    title={record.sidecar.source.name}
                  >
                    <Box className='size-3.5 shrink-0' />
                    <span className='truncate flex-1'>{record.manifest.name}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[10px] tabular-nums',
                        hasUpdate ? 'text-amber-500' : 'text-muted-foreground',
                      )}
                    >
                      {record.sidecar.ref}
                    </span>
                  </button>
                  {hasUpdate ? (
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-5 text-amber-500 hover:text-amber-400'
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdate(record.id);
                      }}
                      title={`Update to ${check?.latest}`}
                    >
                      <ArrowDownToLine className='size-3' />
                    </Button>
                  ) : (
                    <Button
                      size='icon'
                      variant='ghost'
                      className='size-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground'
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdate(record.id);
                      }}
                      title='Reinstall current version'
                    >
                      <RefreshCw className='size-3' />
                    </Button>
                  )}
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive'
                    onClick={(e) => {
                      e.stopPropagation();
                      onUninstall(record.id);
                    }}
                    title='Uninstall'
                  >
                    <Trash2 className='size-3' />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : null}
        {records.length === 0 && installed.length === 0 ? (
          <div className='px-3 py-4 text-xs text-muted-foreground italic'>
            No extensions yet. Click + to create a local one or download to install from a repo.
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  );
}
