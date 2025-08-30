'use client';

import { Plus, X } from 'lucide-react';
import { useState, useCallback } from 'react';

import { cn } from '@/lib/utils';

export type EditorFile = string; // relative path like 'src/client.tsx'

interface FileTabsProps {
  files: Record<string, string>;
  active: EditorFile;
  onSelect: (file: EditorFile) => void;
  onCreate: (filePath: string) => void;
  onDelete: (filePath: string) => void;
  readOnly?: boolean;
}

function fileLanguage(file: string): string {
  if (file.endsWith('.json')) {
    return 'json';
  }
  if (file.endsWith('.ts') || file.endsWith('.tsx')) {
    return 'tsx';
  }
  return 'text';
}

function fileLabel(file: string): string {
  // Just show filename, not full path
  return file.split('/').pop() ?? file;
}

function fileTooltip(file: string): string {
  return file;
}

export { fileLanguage };

export function FileTabs({ files, active, onSelect, onCreate, onDelete, readOnly }: FileTabsProps) {
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState('');

  const sortedFiles = Object.keys(files).sort((a, b) => {
    // Manifest first, then alphabetical
    if (a === 'extension.json') {
      return -1;
    }
    if (b === 'extension.json') {
      return 1;
    }
    return a.localeCompare(b);
  });

  const handleCreate = useCallback(() => {
    setCreating(true);
    setNewPath('src/');
  }, []);

  const handleConfirm = useCallback(() => {
    const trimmed = newPath.trim();
    if (trimmed && !files[trimmed]) {
      onCreate(trimmed);
    }
    setCreating(false);
    setNewPath('');
  }, [newPath, files, onCreate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    } else if (e.key === 'Escape') {
      setCreating(false);
      setNewPath('');
    }
  }, [handleConfirm]);

  return (
    <div className='flex items-center gap-0.5 border-b overflow-x-auto min-h-[32px]'>
      {sortedFiles.map((file) => (
        <div
          key={file}
          className={cn(
            'group flex items-center gap-1 px-2 py-1.5 text-xs font-mono border-b-2 border-transparent hover:bg-accent/40 transition-colors cursor-pointer shrink-0',
            active === file && 'border-primary text-foreground',
            active !== file && 'text-muted-foreground',
          )}
          onClick={() => onSelect(file)}
          title={fileTooltip(file)}
        >
          <span className='truncate max-w-[120px]'>{fileLabel(file)}</span>
          {!readOnly && !file.startsWith('extension.json') && (
            <button
              className='opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0'
              onClick={(e) => {
                e.stopPropagation();
                onDelete(file);
              }}
            >
              <X className='size-3' />
            </button>
          )}
        </div>
      ))}

      {creating ? (
        <div className='flex items-center px-1 shrink-0'>
          <input
            autoFocus
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              setCreating(false); setNewPath('');
            }}
            className='w-32 text-xs font-mono bg-transparent border border-primary rounded px-1 py-0.5 outline-none'
            placeholder='src/new-file.tsx'
          />
        </div>
      ) : !readOnly ? (
        <button
          onClick={handleCreate}
          className='px-1.5 py-1 text-muted-foreground hover:text-foreground shrink-0'
          title='New file'
        >
          <Plus className='size-3.5' />
        </button>
      ) : null}
    </div>
  );
}
