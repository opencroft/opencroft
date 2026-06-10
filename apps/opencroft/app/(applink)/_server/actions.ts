import { appLink, db } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq } from 'drizzle-orm'

export const getAppLinks = createServerFn().handler(async () => {
  return db.query.appLink.findMany({ orderBy: asc(appLink.order) })
})

export const createAppLink = createServerFn({ method: 'POST' })
  .inputValidator((data: { title: string; url: string }) => data)
  .handler(async ({ data }) => {
    const last = await db.query.appLink.findFirst({ orderBy: desc(appLink.order) })
    return db
      .insert(appLink)
      .values({ ...data, order: (last?.order ?? -1) + 1 })
      .returning()
      .get()
  })

export const updateAppLink = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; title: string; url: string }) => data)
  .handler(async ({ data }) => {
    return db.update(appLink).set({ title: data.title, url: data.url }).where(eq(appLink.id, data.id)).returning().get()
  })

export const deleteAppLink = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    return db.delete(appLink).where(eq(appLink.id, id)).returning().get()
  })
