'use server';

import * as dockerStorage from '@/app/(filemanager)/files/server/storage-docker';
import * as s3Storage from '@/app/(filemanager)/files/server/storage-s3';
import * as sshStorage from '@/app/(filemanager)/files/server/storage-ssh';
import * as wslStorage from '@/app/(filemanager)/files/server/storage-wsl';
import {
  StorageConnection,
  FileEntry,
  DockerConfig,
  S3Config,
  SshConfig,
  WslConfig,
  ListFilesParams,
  TransferFileParams,
  UploadFileParams,
  DeleteFileParams,
  RenameFileParams,
  CreateDirectoryParams,
} from '@/app/(filemanager)/files/types';

function getStorage(connection: StorageConnection) {
  const config = connection.config;
  if (connection.type === 's3') {
    const c = config as S3Config;
    return {
      listFiles: (path: string) => s3Storage.listFiles(c, path),
      downloadFile: (path: string) => s3Storage.downloadFile(c, path),
      uploadFile: (path: string, data: string, filename: string) => s3Storage.uploadFile(c, path, data, filename),
      deleteFile: (path: string) => s3Storage.deleteFile(c, path),
      renameFile: (oldPath: string, newPath: string) => s3Storage.renameFile(c, oldPath, newPath),
      createDirectory: (path: string) => s3Storage.createDirectory(c, path),
    };
  }
  if (connection.type === 'wsl') {
    const c = config as WslConfig;
    return {
      listFiles: (path: string) => wslStorage.listFiles(c, path),
      downloadFile: (path: string) => wslStorage.downloadFile(c, path),
      uploadFile: (path: string, data: string, filename: string) => wslStorage.uploadFile(c, path, data, filename),
      deleteFile: (path: string) => wslStorage.deleteFile(c, path),
      renameFile: (oldPath: string, newPath: string) => wslStorage.renameFile(c, oldPath, newPath),
      createDirectory: (path: string) => wslStorage.createDirectory(c, path),
    };
  }
  if (connection.type === 'docker') {
    const c = config as DockerConfig;
    return {
      listFiles: (path: string) => dockerStorage.listFiles(c, path),
      downloadFile: (path: string) => dockerStorage.downloadFile(c, path),
      uploadFile: (path: string, data: string, filename: string) => dockerStorage.uploadFile(c, path, data, filename),
      deleteFile: (path: string) => dockerStorage.deleteFile(c, path),
      renameFile: (oldPath: string, newPath: string) => dockerStorage.renameFile(c, oldPath, newPath),
      createDirectory: (path: string) => dockerStorage.createDirectory(c, path),
    };
  }
  const c = config as SshConfig;
  return {
    listFiles: (path: string) => sshStorage.listFiles(c, path),
    downloadFile: (path: string) => sshStorage.downloadFile(c, path),
    uploadFile: (path: string, data: string, filename: string) => sshStorage.uploadFile(c, path, data, filename),
    deleteFile: (path: string) => sshStorage.deleteFile(c, path),
    renameFile: (oldPath: string, newPath: string) => sshStorage.renameFile(c, oldPath, newPath),
    createDirectory: (path: string) => sshStorage.createDirectory(c, path),
  };
}

export async function listFiles(params: ListFilesParams): Promise<FileEntry[]> {
  const storage = getStorage(params.connection);
  return storage.listFiles(params.path);
}

export async function downloadFile(params: TransferFileParams): Promise<string> {
  const storage = getStorage(params.connection);
  return storage.downloadFile(params.path);
}

export async function uploadFile(params: UploadFileParams): Promise<void> {
  const storage = getStorage(params.connection);
  await storage.uploadFile(params.path, params.data, params.filename);
}

export async function deleteFile(params: DeleteFileParams): Promise<void> {
  const storage = getStorage(params.connection);
  await storage.deleteFile(params.path);
}

export async function renameFile(params: RenameFileParams): Promise<void> {
  const storage = getStorage(params.connection);
  await storage.renameFile(params.oldPath, params.newPath);
}

export async function createDirectory(params: CreateDirectoryParams): Promise<void> {
  const storage = getStorage(params.connection);
  await storage.createDirectory(params.path);
}

export async function testConnection(connection: StorageConnection): Promise<boolean> {
  const storage = getStorage(connection);
  await storage.listFiles('/');
  return true;
}
