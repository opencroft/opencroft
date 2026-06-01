import { createServerFn } from '@tanstack/react-start'

import { prisma } from '@opencroft/db'

export const getAppLinks = createServerFn().handler(async () => {
  return prisma.appLink.findMany({ orderBy: { order: 'asc' } })
})

export const createAppLink = createServerFn({ method: 'POST' })
  .inputValidator((data: { title: string; url: string }) => data)
  .handler(async ({ data }) => {
    const last = await prisma.appLink.findFirst({ orderBy: { order: 'desc' } })
    return prisma.appLink.create({
      data: { ...data, order: (last?.order ?? -1) + 1 },
    })
  })

export const updateAppLink = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; title: string; url: string }) => data)
  .handler(async ({ data }) => {
    return prisma.appLink.update({
      where: { id: data.id },
      data: { title: data.title, url: data.url },
    })
  })

export const deleteAppLink = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    return prisma.appLink.delete({ where: { id } })
  })
