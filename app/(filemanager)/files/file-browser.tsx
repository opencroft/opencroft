'use client';

import { ArrowUp, Check, Download, File, Folder, FolderPlus, Loader2, Pencil, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { UploadEntry, useFileManager } from '@/app/(filemanager)/files/filemanager-provider';
import { FileEntry } from '@/app/(filemanager)/files/types';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Flex } from '@/components/ui/layout/flex';
import { ScrollContent } from '@/components/ui/layout/scrollpage';

function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let size = bytes;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  return `${size.toFixed(idx > 0 ? 1 : 0)} ${units[idx]}`;
}

// Collect all FileSystemEntry references synchronously, then read files async
function collectEntries(entry: FileSystemEntry, basePath: string): Promise<{ file: File; relativePath: string }[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        file => resolve([{ file, relativePath: basePath }]),
        reject,
      );
    });
  }

  return new Promise((resolve, reject) => {
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const dirPath = basePath ? `${basePath}${entry.name}/` : `${entry.name}/`;
    dirReader.readEntries(async (children) => {
      const results: { file: File; relativePath: string }[] = [];
      for (const child of children) {
        results.push(...await collectEntries(child, dirPath));
      }
      resolve(results);
    }, reject);
  });
}

function useFocusRef() {
  return useCallback((el: HTMLInputElement | null) => {
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.select();
      });
    }
  }, []);
}

function InlineInput({ initial, onSubmit, onCancel }: {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const focusRef = useFocusRef();

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initial) {
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <Input
      ref={focusRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          submit();
        }
        if (e.key === 'Escape') {
          onCancel();
        }
      }}
      onBlur={submit}
      className="h-6 text-sm px-1 py-0"
      onClick={e => e.stopPropagation()}
    />
  );
}

function FileRow({ entry, isRenaming, onNavigate, onDownload, onDelete, onRenameStart, onRenameSubmit, onRenameCancel }: {
  entry: FileEntry;
  isRenaming: boolean;
  onNavigate: (path: string) => void;
  onDownload: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onRenameStart: () => void;
  onRenameSubmit: (newName: string) => void;
  onRenameCancel: () => void;
}) {
  const isDir = entry.type === 'directory';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="flex items-center gap-3 px-3 py-2 hover:bg-accent/50 rounded-md cursor-pointer text-sm"
          onClick={() => isDir && !isRenaming && onNavigate(entry.path)}
          onContextMenu={e => e.stopPropagation()}
        >
          {isDir
            ? <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
            : <File className="h-4 w-4 text-muted-foreground shrink-0" />
          }
          {isRenaming ? (
            <InlineInput initial={entry.name} onSubmit={onRenameSubmit} onCancel={onRenameCancel} />
          ) : (
            <span className="flex-1 truncate" onDoubleClick={(e) => {
              e.stopPropagation(); onRenameStart();
            }}>
              {entry.name}
            </span>
          )}
          <span className="text-muted-foreground w-20 text-right">{formatSize(entry.size)}</span>
          <span className="text-muted-foreground w-40 text-right hidden md:block">
            {entry.modified ? new Date(entry.modified).toLocaleString() : '-'}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRenameStart}>
          <Pencil className="h-4 w-4 mr-2" />
          Rename
        </ContextMenuItem>
        {!isDir && (
          <ContextMenuItem onClick={() => onDownload(entry)}>
            <Download className="h-4 w-4 mr-2" />
            Download
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive" onClick={() => onDelete(entry)}>
          <Trash2 className="h-4 w-4 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function UploadRow({ entry, onCancel }: { entry: UploadEntry; onCancel: () => void }) {
  const pct = entry.total > 0 ? Math.round((entry.loaded / entry.total) * 100) : 0;
  const label = entry.path ? `${entry.path}${entry.name}` : entry.name;
  const active = !entry.done && !entry.cancelled;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 text-sm">
      <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <span className={`truncate ${entry.cancelled ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>{label}</span>
          <span className="text-muted-foreground shrink-0">
            {entry.cancelled
              ? 'Cancelled'
              : entry.done
                ? formatSize(entry.total)
                : `${formatSize(entry.loaded)} / ${formatSize(entry.total)} — ${formatSize(entry.speed)}/s`
            }
          </span>
        </div>
        <div className="h-1 bg-accent rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-200 ${
              entry.cancelled ? 'bg-destructive' : entry.done ? 'bg-green-500' : 'bg-primary'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {active && (
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const crumbs = parts.map((part, i) => ({
    label: part,
    path: '/' + parts.slice(0, i + 1).join('/'),
  }));

  return (
    <Flex row align="center" className="gap-1 text-sm text-muted-foreground min-w-0 overflow-hidden">
      <button className="hover:text-foreground shrink-0" onClick={() => onNavigate('/')}>
        /
      </button>
      {crumbs.map((crumb, i) => (
        <Flex row align="center" className="gap-1 min-w-0" key={crumb.path}>
          {i > 0 && <span>/</span>}
          <button className="hover:text-foreground truncate" onClick={() => onNavigate(crumb.path)}>
            {crumb.label}
          </button>
        </Flex>
      ))}
    </Flex>
  );
}

function NewFolderRow({ onSubmit, onCancel }: { onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const focusRef = useFocusRef();

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-accent/30 rounded-md text-sm">
      <Folder className="h-4 w-4 text-muted-foreground" />
      <Input
        ref={focusRef}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            submit();
          }
          if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={() => {
          if (!name.trim()) {
            onCancel();
          }
        }}
        placeholder="Folder name"
        className="h-7 flex-1"
      />
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={submit}>
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function FileBrowser() {
  const fm = useFileManager();
  const inputRef = useRef<HTMLInputElement>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  if (!fm.activeConnection) {
    return null;
  }

  const parentPath = fm.currentPath === '/'
    ? null
    : '/' + fm.currentPath.split('/').filter(Boolean).slice(0, -1).join('/') || '/';

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files ?? []);
    if (fileList.length === 0) {
      return;
    }
    fm.uploadFiles(fileList.map(f => ({ file: f, relativePath: '' })));
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);

    // Grab all entries synchronously before dataTransfer is cleared
    const entries: FileSystemEntry[] = [];
    const fallbackFiles: File[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      fallbackFiles.push(...Array.from(e.dataTransfer.files));
    }

    // Now read files async from the collected entries
    const run = async () => {
      const allFiles: { file: File; relativePath: string }[] = [];
      for (const entry of entries) {
        allFiles.push(...await collectEntries(entry, ''));
      }
      for (const file of fallbackFiles) {
        allFiles.push({ file, relativePath: '' });
      }
      if (allFiles.length > 0) {
        fm.uploadFiles(allFiles);
      }
    };
    run();
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const sorted = [...fm.files].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return (
    <Flex
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative flex-1 min-h-0 overflow-hidden"
    >
      {dragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-md">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop files or folders to upload</span>
          </div>
        </div>
      )}
      <Flex row withSpacing align="center" className="border-b px-3 shrink-0">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={parentPath === null} onClick={() => parentPath && fm.navigate(parentPath)}>
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Breadcrumbs path={fm.currentPath} onNavigate={fm.navigate} />
        <input ref={inputRef} type="file" multiple className="hidden" onChange={handleUpload} />
      </Flex>
      {fm.uploads.length > 0 && (
        <div className="border-b shrink-0 py-1">
          {fm.uploads.map(entry => (
            <UploadRow key={entry.id} entry={entry} onCancel={() => fm.cancelUpload(entry.id)} />
          ))}
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollContent>
            {fm.loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-2">
                {creatingFolder && (
                  <NewFolderRow onSubmit={name => {
                    setCreatingFolder(false); fm.mkdir(name);
                  }} onCancel={() => setCreatingFolder(false)} />
                )}
                {sorted.map(entry => (
                  <FileRow
                    key={entry.path}
                    entry={entry}
                    isRenaming={renamingPath === entry.path}
                    onNavigate={fm.navigate}
                    onDownload={e => fm.download(e)}
                    onDelete={e => fm.remove(e.path)}
                    onRenameStart={() => setRenamingPath(entry.path)}
                    onRenameSubmit={(newName) => {
                      setRenamingPath(null); fm.rename(entry.path, newName);
                    }}
                    onRenameCancel={() => setRenamingPath(null)}
                  />
                ))}
                {sorted.length === 0 && !creatingFolder && (
                  <div className="text-center text-muted-foreground py-12">
                    Empty directory
                  </div>
                )}
              </div>
            )}
          </ScrollContent>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setCreatingFolder(true)}>
            <FolderPlus className="h-4 w-4 mr-2" />
            New Folder
          </ContextMenuItem>
          <ContextMenuItem onClick={() => inputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-2" />
            Upload File
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={fm.refresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Flex>
  );
}
