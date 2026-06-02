import { defineConfig } from 'drizzle-kit'

// Path to the SQLite file. Defaults to the app's data dir; override with
// DATABASE_URL (e.g. in Docker, where it lives next to the app at runtime).
const url = process.env.DATABASE_URL ?? '../../apps/opencroft/data/opencroft.db'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url },
})
