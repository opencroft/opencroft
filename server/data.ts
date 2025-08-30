'use server';

import { prisma } from '@/server/prisma';

// ── Setting CRUD ──

export async function getSetting(id: string) {
  return prisma.setting.findUnique({ where: { id } });
}

export async function upsertSetting(id: string, data: string) {
  return prisma.setting.upsert({
    where: { id },
    create: { id, data },
    update: { data },
  });
}

export async function deleteSetting(id: string) {
  const setting = await prisma.setting.delete({ where: { id } }).catch(() => null);
  return setting !== null;
}
