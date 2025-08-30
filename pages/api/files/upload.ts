import type { NextApiRequest, NextApiResponse } from 'next';

import * as dockerStorage from '@/app/(filemanager)/files/server/storage-docker';
import * as s3Storage from '@/app/(filemanager)/files/server/storage-s3';
import * as sshStorage from '@/app/(filemanager)/files/server/storage-ssh';
import * as wslStorage from '@/app/(filemanager)/files/server/storage-wsl';
import { StorageConnection, DockerConfig, S3Config, SshConfig, WslConfig } from '@/app/(filemanager)/files/types';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const connectionJson = req.headers['x-connection'] as string;
  const path = req.headers['x-path'] as string;
  const filename = req.headers['x-filename'] as string;

  if (!connectionJson || !path || !filename) {
    res.status(400).json({ error: 'Missing fields' });
    return;
  }

  console.log(`Upload: ${filename} to ${path} via ${connectionJson.substring(0, 50)}...`);

  try {
    const connection: StorageConnection = JSON.parse(connectionJson);

    if (connection.type === 'ssh') {
      await sshStorage.uploadStream(connection.config as SshConfig, path, req, filename);
    } else if (connection.type === 's3') {
      await s3Storage.uploadStream(connection.config as S3Config, path, req, filename);
    } else if (connection.type === 'docker') {
      await dockerStorage.uploadStream(connection.config as DockerConfig, path, req, filename);
    } else {
      await wslStorage.uploadStream(connection.config as WslConfig, path, req, filename);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: String(err) });
  }
}
