'use server';

import { prisma } from '@/server/prisma';

export async function getAppLinks() {
  return prisma.appLink.findMany({ orderBy: { order: 'asc' } });
}

export async function createAppLink(data: { title: string; url: string }) {
  const last = await prisma.appLink.findFirst({ orderBy: { order: 'desc' } });
  return prisma.appLink.create({
    data: { ...data, order: (last?.order ?? -1) + 1 },
  });
}

export async function updateAppLink(data: { id: string; title: string; url: string }) {
  return prisma.appLink.update({
    where: { id: data.id },
    data: { title: data.title, url: data.url },
  });
}

export async function deleteAppLink(id: string) {
  return prisma.appLink.delete({ where: { id } });
}
