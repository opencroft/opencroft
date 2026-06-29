import { defineConfig } from 'drizzle-kit'

// Postgres dialect for both drivers. With a remote DATABASE_URL drizzle-kit
// targets node-postgres; otherwise it drives the embedded PGlite instance at
// PGLITE_PATH (used by `generate`/`push`/`studio`).
const url = process.env.DATABASE_URL
const isRemote = !!url && /^postgres(ql)?:\/\//.test(url)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  ...(isRemote
    ? { dbCredentials: { url: url as string } }
    : { driver: 'pglite', dbCredentials: { url: process.env.PGLITE_PATH ?? '../../apps/opencroft/data/pglite' } }),
})
