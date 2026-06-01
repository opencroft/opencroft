'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, ReactNode } from 'react';

import * as actions from '@/app/(filemanager)/files/server/actions';
import * as connectionActions from '@/app/(filemanager)/files/server/connection-actions';
import { StorageConnection, FileEntry } from '@/app/(filemanager)/files/types';

export interface UploadEntry {
  id: string;
  name: string;
  path: string;
  loaded: number;
  total: number;
  speed: number;
  done: boolean;
  cancelled: boolean;
}

interface FileManagerContextType {
  connections: StorageConnection[];
  activeConnection: StorageConnection | null;
  currentPath: string;
  files: FileEntry[];
  loading: boolean;
  uploads: UploadEntry[];
  addConnection: (connection: StorageConnection) => void;
  updateConnection: (connection: StorageConnection) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (connection: StorageConnection | null) => void;
  navigate: (path: string) => void;
  refresh: () => void;
  uploadFiles: (files: { file: File; relativePath: string }[]) => void;
  cancelUpload: (id: string) => void;
  download: (entry: FileEntry) => Promise<void>;
  remove: (path: string) => Promise<void>;
  rename: (oldPath: string, newName: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

const FileManagerContext = createContext<FileManagerContextType | null>(null);

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function FileManagerProvider({ children, initialConnection }: { children: ReactNode; initialConnection?: StorageConnection }) {
  const [connections, setConnections] = useState<StorageConnection[]>(initialConnection ? [initialConnection] : []);
  const [activeConnection, setActiveConnection] = useState<StorageConnection | null>(initialConnection || null);
  const [currentPath, setCurrentPath] = useState('/');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const connRef = useRef<StorageConnection | null>(initialConnection || null);
  const pathRef = useRef('/');
  const xhrMap = useRef<Map<string, XMLHttpRequest>>(new Map());

  useEffect(() => {
    if (!initialConnection) {
      connectionActions.getConnections().then(setConnections);
    }
  }, [initialConnection]);

  useEffect(() => {
    const conn = connRef.current;
    const path = pathRef.current;
    if (!conn) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    actions.listFiles({ data: { connection: conn, path } }).then(result => {
      if (!cancelled) {
        setFiles(result);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeConnection, currentPath, refreshKey]);

  const navigate = useCallback((path: string) => {
    if (loading) {
      return;
    }
    pathRef.current = path;
    setCurrentPath(path);
    setFiles([]);
  }, [loading]);

  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  const selectConnection = useCallback((connection: StorageConnection | null) => {
    connRef.current = connection;
    pathRef.current = '/';
    setActiveConnection(connection);
    setCurrentPath('/');
    setFiles([]);
  }, []);

  const addConnection = useCallback(async (connection: StorageConnection) => {
    await connectionActions.saveConnection({ data: connection });
    setConnections(prev => [...prev, connection]);
  }, []);

  const updateConnection = useCallback(async (connection: StorageConnection) => {
    await connectionActions.saveConnection({ data: connection });
    setConnections(prev => prev.map(c => c.id === connection.id ? connection : c));
    if (connRef.current?.id === connection.id) {
      connRef.current = connection;
      setActiveConnection(connection);
    }
  }, []);

  const removeConnection = useCallback(async (id: string) => {
    await connectionActions.deleteConnection({ data: id });
    setConnections(prev => prev.filter(c => c.id !== id));
    if (connRef.current?.id === id) {
      connRef.current = null;
      pathRef.current = '/';
      setActiveConnection(null);
      setCurrentPath('/');
      setFiles([]);
    }
  }, []);

  const uploadOne = useCallback((file: File, uploadPath: string, entry: UploadEntry): Promise<void> => {
    const conn = connRef.current;
    if (!conn) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrMap.current.set(entry.id, xhr);

      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('x-connection', JSON.stringify(conn));
      xhr.setRequestHeader('x-path', uploadPath);
      xhr.setRequestHeader('x-filename', file.name);

      let lastLoaded = 0;
      let lastTime = Date.now();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          const speed = dt > 0.1 ? (e.loaded - lastLoaded) / dt : entry.speed;
          lastLoaded = e.loaded;
          lastTime = now;
          setUploads(prev => prev.map(u =>
            u.id === entry.id ? { ...u, loaded: e.loaded, speed } : u,
          ));
        }
      };

      xhr.onload = () => {
        xhrMap.current.delete(entry.id);
        setUploads(prev => prev.map(u =>
          u.id === entry.id ? { ...u, loaded: u.total, done: true, speed: 0 } : u,
        ));
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(xhr.statusText));
        }
      };

      xhr.onabort = () => {
        xhrMap.current.delete(entry.id);
        setUploads(prev => prev.map(u =>
          u.id === entry.id ? { ...u, cancelled: true, speed: 0 } : u,
        ));
        resolve();
      };

      xhr.onerror = () => {
        xhrMap.current.delete(entry.id);
        reject(new Error('Upload failed'));
      };

      xhr.send(file);
    });
  }, []);

  const cancelUpload = useCallback((id: string) => {
    const xhr = xhrMap.current.get(id);
    if (xhr) {
      xhr.abort();
    }
  }, []);

  const uploadFiles = useCallback((items: { file: File; relativePath: string }[]) => {
    const conn = connRef.current;
    if (!conn) {
      return;
    }
    const base = pathRef.current;

    const entries: UploadEntry[] = items.map(item => ({
      id: crypto.randomUUID(),
      name: item.file.name,
      path: item.relativePath,
      loaded: 0,
      total: item.file.size,
      speed: 0,
      done: false,
      cancelled: false,
    }));

    setUploads(prev => [...prev, ...entries]);

    const promises = items.map((item, i) => {
      const dir = item.relativePath
        ? base.endsWith('/') ? base + item.relativePath : base + '/' + item.relativePath
        : base;
      return uploadOne(item.file, dir, entries[i]);
    });

    Promise.all(promises).then(() => {
      setTimeout(() => {
        setUploads(prev => prev.filter(u => !entries.some(e => e.id === u.id)));
      }, 2000);
      setRefreshKey(k => k + 1);
    });
  }, [uploadOne]);

  const download = useCallback(async (entry: FileEntry) => {
    const conn = connRef.current;
    if (!conn) {
      return;
    }
    const data = await actions.downloadFile({ data: { connection: conn, path: entry.path } });
    const blob = new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))]);
    triggerDownload(blob, entry.name);
  }, []);

  const remove = useCallback(async (path: string) => {
    const conn = connRef.current;
    if (!conn) {
      return;
    }
    await actions.deleteFile({ data: { connection: conn, path } });
    setRefreshKey(k => k + 1);
  }, []);

  const rename = useCallback(async (oldPath: string, newName: string) => {
    const conn = connRef.current;
    if (!conn) {
      return;
    }
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');
    await actions.renameFile({ data: { connection: conn, oldPath, newPath } });
    setRefreshKey(k => k + 1);
  }, []);

  const mkdir = useCallback(async (path: string) => {
    const conn = connRef.current;
    if (!conn) {
      return;
    }
    const base = pathRef.current;
    const fullPath = base.endsWith('/') ? base + path : base + '/' + path;
    await actions.createDirectory({ data: { connection: conn, path: fullPath } });
    setRefreshKey(k => k + 1);
  }, []);

  const value: FileManagerContextType = {
    connections,
    activeConnection,
    currentPath,
    files,
    loading,
    uploads,
    addConnection,
    updateConnection,
    removeConnection,
    setActiveConnection: selectConnection,
    navigate,
    refresh,
    uploadFiles,
    cancelUpload,
    download,
    remove,
    rename,
    mkdir,
  };

  return (
    <FileManagerContext.Provider value={value}>
      {children}
    </FileManagerContext.Provider>
  );
}

export function useFileManager() {
  const context = useContext(FileManagerContext);
  if (!context) {
    throw new Error('useFileManager must be used within a FileManagerProvider');
  }
  return context;
}
