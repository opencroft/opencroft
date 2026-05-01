'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  compileLocalExtension,
  createLocalExtension,
  deleteLocalExtension,
  listLocalExtensions,
  type LocalExtensionRecord,
  updateLocalExtension,
} from '@/app/(extension-editor)/_actions/local-extensions-actions';
import { ExtensionWorkspace } from '@/app/(extension-editor)/_components/extension-workspace';
import { ExtensionsListPanel } from '@/app/(extension-editor)/_components/extensions-list-panel';
import { extensionTemplate } from '@/app/(extension-editor)/_templates/template';
import { loadExtension } from '@/app/(extension-runtime)/_client/loader';
import { type CompileError } from '@/app/(extension-runtime)/_types';
import { Flex } from '@/components/ui/layout/flex';

function recordSignature(files: Record<string, string>): string {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}\n${v}`)
    .join('\n\u0000\n');
}

function pickUntitledSlug(existing: LocalExtensionRecord[]): string {
  const taken = new Set(existing.map((r) => r.slug));
  let i = 1;
  while (taken.has(i === 1 ? 'untitled' : `untitled-${i}`)) {
    i += 1;
  }
  return i === 1 ? 'untitled' : `untitled-${i}`;
}

export default function ExtensionsPage() {
  const [records, setRecords] = useState<LocalExtensionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [savedSignature, setSavedSignature] = useState<string>('');
  const [activeFile, setActiveFile] = useState<string>('extension.json');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<CompileError[]>([]);
  const [warnings, setWarnings] = useState<CompileError[]>([]);
  const [previewTypeId, setPreviewTypeId] = useState<string | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const autoPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSignature = useRef<string>('');

  const refresh = useCallback(async (): Promise<LocalExtensionRecord[]> => {
    const list = await listLocalExtensions();
    setRecords(list);
    return list;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId],
  );

  // Load files when selection changes
  useEffect(() => {
    setPreviewTypeId(null);
    if (selected) {
      setFiles({ ...selected.files });
      setSavedSignature(recordSignature(selected.files));
      setErrors([]);
      setWarnings([]);
      const fileKeys = Object.keys(selected.files).sort();
      const firstNonManifest = fileKeys.find((f) => f !== 'extension.json');
      setActiveFile(firstNonManifest ?? 'extension.json');
    } else {
      setFiles({});
      setActiveFile('extension.json');
    }
  }, [selectedId, selected]);

  const dirty = useMemo(() => {
    return recordSignature(files) !== savedSignature;
  }, [files, savedSignature]);

  const autoPersistAndCompile = useCallback(async () => {
    if (!selectedId || Object.keys(files).length === 0) {
      return;
    }
    try {
      JSON.parse(files['extension.json'] ?? '{}');
    } catch {
      return;
    }
    const signature = recordSignature(files);
    if (signature === lastAutoSignature.current) {
      return;
    }
    lastAutoSignature.current = signature;
    setBusy(true);
    setErrors([]);
    setWarnings([]);
    try {
      const record = await updateLocalExtension(selectedId, files);
      setSavedSignature(recordSignature(record.files));
      setRecords((prev) => prev.map((r) => (r.id === record.id ? record : r)));
      const result = await compileLocalExtension(selectedId);
      setErrors(result.errors);
      setWarnings(result.warnings);
      if (result.success) {
        const decl = await loadExtension(record.manifest);
        if (decl && decl.nodes && decl.nodes[0]) {
          setPreviewTypeId(decl.nodes[0].typeId);
          setPreviewVersion((v) => v + 1);
        }
      }
    } catch (err) {
      console.error('[editor] auto-compile failed', err);
    } finally {
      setBusy(false);
    }
  }, [files, selectedId]);

  useEffect(() => {
    if (!dirty || Object.keys(files).length === 0 || !selectedId) {
      return;
    }
    if (autoPersistTimer.current) {
      clearTimeout(autoPersistTimer.current);
    }
    autoPersistTimer.current = setTimeout(() => {
      autoPersistAndCompile();
    }, 700);
    return () => {
      if (autoPersistTimer.current) {
        clearTimeout(autoPersistTimer.current);
      }
    };
  }, [dirty, files, selectedId, autoPersistAndCompile]);

  useEffect(() => {
    lastAutoSignature.current = savedSignature;
  }, [selectedId, savedSignature]);

  const handleChange = useCallback(
    (file: string, value: string) => {
      setFiles((prev) => ({ ...prev, [file]: value }));
    },
    [],
  );

  const handleCreateFile = useCallback((filePath: string) => {
    setFiles((prev) => ({ ...prev, [filePath]: '' }));
    setActiveFile(filePath);
  }, []);

  const handleDeleteFile = useCallback((filePath: string) => {
    setFiles((prev) => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
    setActiveFile((current) => {
      if (current === filePath) {
        const remaining = Object.keys(files).filter((f) => f !== filePath);
        return remaining[0] ?? 'extension.json';
      }
      return current;
    });
  }, [files]);

  const handleNew = useCallback(async () => {
    setBusy(true);
    try {
      const list = await listLocalExtensions();
      const slug = pickUntitledSlug(list);
      const templateFiles = extensionTemplate(slug);
      const record = await createLocalExtension(templateFiles);
      await refresh();
      setSelectedId(record.id);
      toast.success(`Created ${record.manifest.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (extensionId: string) => {
    const record = records.find((r) => r.id === extensionId);
    if (!confirm(`Delete ${record?.manifest.name ?? extensionId}?`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteLocalExtension(extensionId);
      await refresh();
      if (selectedId === extensionId) {
        setSelectedId(null);
        setFiles({});
      }
      toast.success('Extension deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [records, selectedId, refresh]);

  const title = selected
    ? `${selected.manifest.name} · ${selected.id}`
    : 'Select a local extension';

  return (
    <Flex expanded className="h-full w-full">
      <Flex row align="center" className="gap-2 p-3 border-b">
        <span className="text-sm font-semibold">Extensions</span>
      </Flex>
      <Flex row expanded className="min-h-0">
        <ExtensionsListPanel
          records={records}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={handleNew}
          onDelete={handleDelete}
        />
        {selectedId && Object.keys(files).length > 0 ? (
          <ExtensionWorkspace
            title={title}
            files={files}
            activeFile={activeFile}
            busy={busy}
            errors={errors}
            warnings={warnings}
            previewTypeId={previewTypeId}
            previewVersion={previewVersion}
            onFileSelect={setActiveFile}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onChange={handleChange}
          />
        ) : (
          <Flex expanded align="center" justify="center" className="text-sm text-muted-foreground">
            Select a local extension from the list, or click + to create a new one.
          </Flex>
        )}
      </Flex>
    </Flex>
  );
}
