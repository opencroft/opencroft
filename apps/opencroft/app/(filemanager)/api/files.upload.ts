import { Readable } from 'node:stream'

import { createFileRoute } from '@tanstack/react-router'
import type { DockerConfig, S3Config, SshConfig, StorageConnection, WslConfig } from '@/app/(filemanager)/_lib/types'
import * as dockerStorage from '@/app/(filemanager)/_server/storage-docker'
import * as s3Storage from '@/app/(filemanager)/_server/storage-s3'
import * as sshStorage from '@/app/(filemanager)/_server/storage-ssh'
import * as wslStorage from '@/app/(filemanager)/_server/storage-wsl'

export const Route = createFileRoute('/(filemanager)/api/files/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const connectionJson = request.headers.get('x-connection')
        const path = request.headers.get('x-path')
        const filename = request.headers.get('x-filename')

        if (!connectionJson || !path || !filename) {
          return Response.json({ error: 'Missing fields' }, { status: 400 })
        }

        const stream = request.body ? Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([])

        try {
          const connection: StorageConnection = JSON.parse(connectionJson)

          if (connection.type === 'ssh') {
            await sshStorage.uploadStream(connection.config as SshConfig, path, stream, filename)
          } else if (connection.type === 's3') {
            await s3Storage.uploadStream(connection.config as S3Config, path, stream, filename)
          } else if (connection.type === 'docker') {
            await dockerStorage.uploadStream(connection.config as DockerConfig, path, stream, filename)
          } else {
            await wslStorage.uploadStream(connection.config as WslConfig, path, stream, filename)
          }

          return Response.json({ ok: true })
        } catch (err) {
          console.error('Upload error:', err)
          return Response.json({ error: String(err) }, { status: 500 })
        }
      },
    },
  },
})
