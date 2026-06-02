import { and, asc, desc, eq, gt, gte, inArray, like, lt, lte, ne, notInArray, or, type SQL, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { schema } from './schema'

/**
 * Minimal Prisma-client-compatible facade over Drizzle. It exists so the legacy
 * `host.prisma.*` extension API (and existing app call-sites) keep working after
 * the Drizzle migration. Prefer the raw Drizzle `db` for new code.
 *
 * Supports the model methods + arg shapes the codebase uses: equality, the
 * `{ not | in | notIn | gt | gte | lt | lte | contains | startsWith | endsWith |
 * equals }` operators, `AND`/`OR`, Prisma compound-unique keys (`field1_field2`),
 * `orderBy`, `take`/`skip`, `select`, and `distinct`.
 */

type AnyDb = BetterSQLite3Database<typeof schema>

// Prisma names compound-unique selectors `field1_field2`; map them to columns.
const COMPOUND: Record<string, Record<string, string[]>> = {
  Secret: { storeId_key: ['storeId', 'key'] },
}

type Cols = Record<string, SQLiteColumn>
type Where = Record<string, unknown>
type OrderBy = Record<string, 'asc' | 'desc'>

function condition(col: SQLiteColumn, spec: unknown): SQL {
  if (spec === null || typeof spec !== 'object' || spec instanceof Date) {
    return eq(col, spec)
  }
  const conds: SQL[] = []
  for (const [op, val] of Object.entries(spec as Record<string, unknown>)) {
    switch (op) {
      case 'equals':
        conds.push(eq(col, val))
        break
      case 'not':
        conds.push(ne(col, val))
        break
      case 'in':
        conds.push(inArray(col, val as unknown[]))
        break
      case 'notIn':
        conds.push(notInArray(col, val as unknown[]))
        break
      case 'gt':
        conds.push(gt(col, val))
        break
      case 'gte':
        conds.push(gte(col, val))
        break
      case 'lt':
        conds.push(lt(col, val))
        break
      case 'lte':
        conds.push(lte(col, val))
        break
      case 'contains':
        conds.push(like(col, `%${val}%`))
        break
      case 'startsWith':
        conds.push(like(col, `${val}%`))
        break
      case 'endsWith':
        conds.push(like(col, `%${val}`))
        break
      default:
        throw new Error(`prisma-compat: unsupported operator '${op}'`)
    }
  }
  return conds.length > 1 ? (and(...conds) as SQL) : conds[0]
}

function buildWhere(cols: Cols, table: string, where?: Where): SQL | undefined {
  if (!where) {
    return undefined
  }
  const compound = COMPOUND[table] ?? {}
  const conds: SQL[] = []
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      const subs = (Array.isArray(v) ? v : [v]).map((w) => buildWhere(cols, table, w as Where)).filter(Boolean) as SQL[]
      if (subs.length) {
        conds.push(and(...subs) as SQL)
      }
    } else if (k === 'OR') {
      const subs = (v as Where[]).map((w) => buildWhere(cols, table, w)).filter(Boolean) as SQL[]
      if (subs.length) {
        conds.push(or(...subs) as SQL)
      }
    } else if (compound[k]) {
      const part = v as Record<string, unknown>
      for (const c of compound[k]) {
        conds.push(eq(cols[c], part[c]))
      }
    } else {
      conds.push(condition(cols[k], v))
    }
  }
  if (!conds.length) {
    return undefined
  }
  return conds.length > 1 ? (and(...conds) as SQL) : conds[0]
}

function buildOrderBy(cols: Cols, orderBy?: OrderBy | OrderBy[]): SQL[] {
  if (!orderBy) {
    return []
  }
  const out: SQL[] = []
  for (const o of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    for (const [field, dir] of Object.entries(o)) {
      out.push(dir === 'desc' ? desc(cols[field]) : asc(cols[field]))
    }
  }
  return out
}

function projection(cols: Cols, fields: string[]): Record<string, SQLiteColumn> {
  return Object.fromEntries(fields.map((f) => [f, cols[f]]))
}

function upsertTarget(cols: Cols, table: string, where: Where): SQLiteColumn[] {
  const compound = COMPOUND[table] ?? {}
  for (const k of Object.keys(where)) {
    if (compound[k]) {
      return compound[k].map((c) => cols[c])
    }
  }
  return Object.keys(where)
    .filter((k) => cols[k])
    .map((k) => cols[k])
}

interface FindArgs {
  where?: Where
  orderBy?: OrderBy | OrderBy[]
  take?: number
  skip?: number
  select?: Record<string, boolean>
  distinct?: string[]
}

function model<T extends SQLiteTable>(db: AnyDb, table: T, name: string) {
  type Row = T['$inferSelect']
  type Insert = T['$inferInsert']
  const cols = table as unknown as Cols
  const base = table as SQLiteTable

  function notFound(op: string): never {
    throw new Error(`prisma-compat: ${name}.${op} matched no rows`)
  }

  return {
    async findMany(args: FindArgs = {}): Promise<Row[]> {
      const fields = args.distinct ?? (args.select ? Object.keys(args.select).filter((k) => args.select?.[k]) : undefined)
      const proj = fields ? projection(cols, fields) : undefined
      const selected = args.distinct ? (proj ? db.selectDistinct(proj) : db.selectDistinct()) : proj ? db.select(proj) : db.select()
      let q = selected.from(base).$dynamic()
      const w = buildWhere(cols, name, args.where)
      if (w) {
        q = q.where(w)
      }
      const order = buildOrderBy(cols, args.orderBy)
      if (order.length) {
        q = q.orderBy(...order)
      }
      if (args.take != null) {
        q = q.limit(args.take)
      }
      if (args.skip != null) {
        q = q.offset(args.skip)
      }
      return q.all() as Row[]
    },
    async findFirst(args: FindArgs = {}): Promise<Row | null> {
      const rows = await this.findMany({ ...args, take: 1 })
      return rows[0] ?? null
    },
    async findUnique(args: { where: Where; select?: Record<string, boolean> }): Promise<Row | null> {
      return this.findFirst(args)
    },
    async create(args: { data: Insert }): Promise<Row> {
      return db.insert(table).values(args.data).returning().get() as Row
    },
    async update(args: { where: Where; data: Partial<Insert> }): Promise<Row> {
      const w = buildWhere(cols, name, args.where)
      const row = db.update(table).set(args.data).where(w).returning().get()
      return (row ?? notFound('update')) as Row
    },
    async upsert(args: { where: Where; create: Insert; update: Partial<Insert> }): Promise<Row> {
      return db
        .insert(table)
        .values(args.create)
        .onConflictDoUpdate({ target: upsertTarget(cols, name, args.where), set: args.update })
        .returning()
        .get() as Row
    },
    async delete(args: { where: Where }): Promise<Row> {
      const w = buildWhere(cols, name, args.where)
      const row = db.delete(table).where(w).returning().get()
      return (row ?? notFound('delete')) as Row
    },
    async deleteMany(args: { where?: Where } = {}): Promise<{ count: number }> {
      const w = buildWhere(cols, name, args.where)
      const res = db.delete(table).where(w).run()
      return { count: res.changes }
    },
    async count(args: { where?: Where } = {}): Promise<number> {
      const w = buildWhere(cols, name, args.where)
      const r = db.select({ c: sql<number>`count(*)` }).from(base).where(w).get()
      return Number(r?.c ?? 0)
    },
  }
}

export function createPrismaCompat(db: AnyDb) {
  return {
    setting: model(db, schema.setting, 'Setting'),
    secret: model(db, schema.secret, 'Secret'),
    appLink: model(db, schema.appLink, 'AppLink'),
    space: model(db, schema.space, 'Space'),
    mcpAuditLog: model(db, schema.mcpAuditLog, 'McpAuditLog'),
  }
}

export type PrismaCompat = ReturnType<typeof createPrismaCompat>
