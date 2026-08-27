import { type Config, defineConfig } from 'drizzle-kit'

// Postgres dialect for both drivers. With a remote DATABASE_URL drizzle-kit
// targets node-postgres; otherwise it drives the embedded PGlite instance at
// PGLITE_PATH (used by `generate`/`push`/`studio`).
const url = process.env.DATABASE_URL
const isRemote = !!url && /^postgres(ql)?:\/\//.test(url)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Config is a union whose members do not all carry `driver`, so no single key
  // can be named here -- Partial is what distributes over it and still refuses a
  // key that belongs to no member.
  ...(isRemote
    ? ({ dbCredentials: { url: url as string } } satisfies Partial<Config>)
    : ({
        driver: 'pglite',
        dbCredentials: { url: process.env.PGLITE_PATH ?? '../../apps/opencroft/data/pglite' },
      } satisfies Partial<Config>)),
})
