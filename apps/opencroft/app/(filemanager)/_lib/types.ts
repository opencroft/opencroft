export type StorageType = 's3' | 'ssh' | 'wsl' | 'docker'

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  basePath: string
}

export interface WslConfig {
  distro: string
  basePath: string
}

export interface DockerConfig {
  containerId: string
  basePath: string
  context?: string
}

export interface StorageConnection {
  id: string
  name: string
  type: StorageType
  config: S3Config | SshConfig | WslConfig | DockerConfig
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modified: string
}

export interface ListFilesParams {
  connection: StorageConnection
  path: string
}

export interface TransferFileParams {
  connection: StorageConnection
  path: string
}

export interface UploadFileParams {
  connection: StorageConnection
  path: string
  data: string // base64 encoded
  filename: string
}

export interface DeleteFileParams {
  connection: StorageConnection
  path: string
}

export interface RenameFileParams {
  connection: StorageConnection
  oldPath: string
  newPath: string
}

export interface CreateDirectoryParams {
  connection: StorageConnection
  path: string
}
