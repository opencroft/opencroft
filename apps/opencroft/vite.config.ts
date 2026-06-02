import { devtools } from '@tanstack/devtools-vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import { WebSocketServer } from 'ws'

/**
 * Mounts the terminal WebSocket handler on Vite's dev HTTP server, mirroring the
 * production upgrade handler. Only intercepts `/api/ws/terminal`; all other
 * upgrades (e.g. Vite HMR) fall through to the remaining listeners.
 */
function wsTerminalPlugin(): Plugin {
  return {
    name: 'opencroft-ws-terminal',
    configureServer(server: ViteDevServer) {
      let wss: WebSocketServer | null = null
      const ensureWss = async () => {
        if (wss) {
          return wss
        }
        const { setupTerminalWss } = await server.ssrLoadModule('/app/(terminal)/_server/terminal.ts')
        wss = new WebSocketServer({ noServer: true })
        setupTerminalWss(wss)
        return wss
      }
      server.httpServer?.on('upgrade', (req, socket, head) => {
        const { pathname } = new URL(req.url ?? '', 'http://localhost')
        if (pathname !== '/api/ws/terminal') {
          return
        }
        ensureWss()
          .then((server) => {
            server.handleUpgrade(req, socket, head, (client) => {
              server.emit('connection', client, req)
            })
          })
          .catch((err) => {
            console.error('[ws-terminal] upgrade failed', err)
            socket.destroy()
          })
      })
    },
  }
}

export default defineConfig({
  server: {
    port: 9999,
    host: '0.0.0.0',
  },
  resolve: {
    tsconfigPaths: true,
  },
  // Native / server-only modules must never be pulled into client dep optimization
  // or bundled for SSR — they are resolved from node_modules at runtime.
  optimizeDeps: {
    exclude: ['ssh2', 'cpu-features', '@lydell/node-pty', 'esbuild', 'esbuild-wasm', 'better-sqlite3'],
  },
  ssr: {
    external: ['ssh2', 'cpu-features', '@lydell/node-pty', 'esbuild', 'esbuild-wasm', 'better-sqlite3'],
  },
  plugins: [
    devtools(),
    wsTerminalPlugin(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'app',
      router: {
        routesDirectory: '.',
        routeFileIgnorePattern: '(^|/)(_[^_/]|router\\.|server\\.|client\\.|start\\.|routeTree\\.gen\\.)',
      },
    }),
    viteReact(),
  ],
})
