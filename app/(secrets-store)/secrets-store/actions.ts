'use server';

import { decrypt, encrypt } from '@/server/crypto';
import { prisma } from '@/server/prisma';

export interface SecretEntry {
  id: string;
  key: string;
  value: string;
}

export async function getSecrets(storeId: string): Promise<SecretEntry[]> {
  const rows = await prisma.secret.findMany({
    where: { storeId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    value: decrypt(r.value),
  }));
}

export async function getSecretValue(storeId: string, key: string): Promise<string | null> {
  const row = await prisma.secret.findUnique({
    where: { storeId_key: { storeId, key } },
  });
  if (!row) {
    return null;
  }
  return decrypt(row.value);
}

export async function setSecret(storeId: string, key: string, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await prisma.secret.upsert({
    where: { storeId_key: { storeId, key } },
    create: { storeId, key, value: encrypted },
    update: { value: encrypted },
  });
}

export async function deleteSecret(storeId: string, key: string): Promise<void> {
  await prisma.secret.delete({
    where: { storeId_key: { storeId, key } },
  }).catch(() => {});
}

export async function deleteStore(storeId: string): Promise<void> {
  await prisma.secret.deleteMany({ where: { storeId } });
}
