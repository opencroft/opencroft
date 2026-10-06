// Run by attachment-routing.test.ts in a process of its own -- see there for
// what it proves. Boots Vite with the Nitro plugin over this app's server
// directory, makes each request it is given the way a browser would, prints
// one JSON line of results, and exits.
//
// A separate process because Nitro's dev integration does not let go: after
// the dev server is closed its file watchers and its worker process are still
// running, and a test that booted it in-process never exits -- which, under a
// runner that runs every file in turn, is the whole suite hanging.

// A throwaway database before anything can open one: the route's session gate
// reaches the auth tables, and this must never be the checkout's own datadir.
import '@opencroft/db/test-env'

import { nitro } from 'nitro/vite'
import { createServer } from 'vite'

const APP_ROOT = new URL('..', import.meta.url).pathname

export interface ProbeRequest {
  path: string
  dest: string
}

export interface ProbeResult extends ProbeRequest {
  status: number
  contentType: string
}

const requests = JSON.parse(process.argv[2] ?? '[]') as ProbeRequest[]
const port = Number(process.argv[3])

const server = await createServer({
  root: APP_ROOT,
  configFile: false,
  logLevel: 'silent',
  resolve: { alias: { '@': APP_ROOT } },
  // A route that draws a component needs JSX compiled; the app's tsconfig
  // leaves it to the React plugin, which this bare config does not load.
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
  plugins: [nitro({ serverDir: './server' })],
})
await server.listen()

const results: ProbeResult[] = []
for (const request of requests) {
  const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
    headers: { 'sec-fetch-dest': request.dest },
  })
  await response.arrayBuffer()
  results.push({ ...request, status: response.status, contentType: response.headers.get('content-type') ?? '' })
}

console.log(`PROBE ${JSON.stringify(results)}`)
await server.close()
process.exit(0)
