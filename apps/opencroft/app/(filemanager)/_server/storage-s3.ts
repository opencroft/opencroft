import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

import type { FileEntry, S3Config } from '@/app/(filemanager)/_lib/types'

function createClient(config: S3Config) {
  const client = new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  })

  // Some S3-compatible endpoints (e.g. RunPod) reject trailing slashes
  // on bucket-only paths like /{bucket}/. Strip before signing.
  client.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { path?: string }
      if (request?.path?.match(/^\/[^/]+\/(\?|$)/)) {
        request.path = request.path.replace(/\/+(\?|$)/, '$1')
      }
      return next(args)
    },
    { step: 'build', name: 'fixTrailingSlash', priority: 'low' },
  )

  return client
}

function normalizePath(path: string) {
  const clean = path.replace(/^\/+/, '')
  return clean && !clean.endsWith('/') ? clean + '/' : clean
}

export async function listFiles(config: S3Config, path: string): Promise<FileEntry[]> {
  const client = createClient(config)
  const prefix = normalizePath(path)

  const response = await client.send(
    new ListObjectsCommand({
      Bucket: config.bucket,
      Delimiter: '/',
      ...(prefix ? { Prefix: prefix } : {}),
    }),
  )

  const entries: FileEntry[] = []

  for (const dir of response.CommonPrefixes ?? []) {
    if (!dir.Prefix) {
      continue
    }
    const name = dir.Prefix.slice(prefix.length).replace(/\/$/, '')
    if (!name) {
      continue
    }
    entries.push({
      name,
      path: '/' + dir.Prefix,
      type: 'directory',
      size: 0,
      modified: '',
    })
  }

  for (const obj of response.Contents ?? []) {
    if (!obj.Key) {
      continue
    }
    const name = prefix ? obj.Key.slice(prefix.length) : obj.Key
    if (!name) {
      continue
    }
    entries.push({
      name,
      path: '/' + obj.Key,
      type: 'file',
      size: obj.Size ?? 0,
      modified: obj.LastModified?.toISOString() ?? '',
    })
  }

  return entries
}

export async function downloadFile(config: S3Config, path: string): Promise<string> {
  const client = createClient(config)
  const key = path.replace(/^\/+/, '')

  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  )

  const bytes = await response.Body?.transformToByteArray()
  if (!bytes) {
    return ''
  }
  return Buffer.from(bytes).toString('base64')
}

export async function uploadFile(config: S3Config, path: string, data: string, filename: string): Promise<void> {
  await uploadStream(config, path, Buffer.from(data, 'base64'), filename)
}

export async function uploadStream(config: S3Config, path: string, body: Buffer | ReadableStream | import('stream').Readable, filename: string): Promise<void> {
  const client = createClient(config)
  const dir = path.replace(/^\/+/, '')
  const key = dir ? `${dir}${filename}` : filename

  const upload = new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: body,
    },
    partSize: 5 * 1024 * 1024,
  })

  await upload.done()
}

async function deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  const response = await client.send(
    new ListObjectsCommand({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
    }),
  )

  // Delete files at this level
  for (const obj of response.Contents ?? []) {
    if (!obj.Key) {
      continue
    }
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
  }

  // Recurse into subdirectories
  for (const dir of response.CommonPrefixes ?? []) {
    if (dir.Prefix) {
      await deletePrefix(client, bucket, dir.Prefix)
    }
  }
}

export async function deleteFile(config: S3Config, path: string): Promise<void> {
  const client = createClient(config)
  const key = path.replace(/^\/+/, '')

  if (key.endsWith('/')) {
    await deletePrefix(client, config.bucket, key)
    return
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  )
}

export async function renameFile(config: S3Config, oldPath: string, newPath: string): Promise<void> {
  const client = createClient(config)
  const oldKey = oldPath.replace(/^\/+/, '')
  const newKey = newPath.replace(/^\/+/, '')

  await client.send(
    new CopyObjectCommand({
      Bucket: config.bucket,
      CopySource: `${config.bucket}/${oldKey}`,
      Key: newKey,
    }),
  )
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: oldKey,
    }),
  )
}

export async function createDirectory(config: S3Config, path: string): Promise<void> {
  const client = createClient(config)
  const dir = normalizePath(path.replace(/^\/+/, ''))
  // S3-compatible endpoints may reject trailing-slash keys.
  // Create a .keep marker file inside the directory instead.
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${dir}.keep`,
      Body: Buffer.from(' '),
    }),
  )
}
