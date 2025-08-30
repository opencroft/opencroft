'use client';

import { Box, Plus, Trash2 } from 'lucide-react';

import { type LocalExtensionRecord } from '@/app/(extension-editor)/_actions/local-extensions-actions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface ExtensionsListPanelProps {
  records: LocalExtensionRecord[];
  selectedId: string | null;
  onSelect: (extensionId: string) => void;
  onNew: () => void;
  onDelete: (extensionId: string) => void;
}

export function ExtensionsListPanel({
  records,
  selectedId,
  onSelect,
  onNew,
  onDelete,
}: ExtensionsListPanelProps) {
  return (
    <aside className='w-60 h-full border-r bg-card flex flex-col shrink-0'>
      <div className='flex items-center gap-2 p-3'>
        <span className='text-sm font-semibold flex-1'>Local Extensions</span>
        <Button size='icon' variant='ghost' className='size-6' onClick={onNew} title='New extension'>
          <Plus className='size-3.5' />
        </Button>
      </div>
      <Separator />
      <ScrollArea className='flex-1 min-h-0'>
        {records.length > 0 ? (
          <div>
            <div className='px-3 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground'>
              Installed
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
        ) : (
          <div className='px-3 py-4 text-xs text-muted-foreground italic'>
            No local extensions. Click + to create one.
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
