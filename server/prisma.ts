import fs from 'node:fs'
import path from 'node:path'

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '@prisma/client'

const dataDir = path.join(process.cwd(), 'data')
const dbFile = path.join(dataDir, 'opencroft.db')
const seedFile = path.join(process.cwd(), 'seed.db')

if (!fs.existsSync(dbFile) && fs.existsSync(seedFile)) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(seedFile, dbFile)
}

const adapter = new PrismaBetterSqlite3({ url: `file:${dbFile}` })

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma || new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
