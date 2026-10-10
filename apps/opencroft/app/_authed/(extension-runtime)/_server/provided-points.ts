import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { type ClientHostApi, loadClientHostApi } from '@/app/_authed/(extension-runtime)/_server/client-host-api'
import { extDistDir, PROVIDED_POINTS_FILE } from '@/app/_authed/(extension-runtime)/_server/paths'
import { statMaybe } from '@/app/_authed/(extension-runtime)/_server/source-mtime'
import type { BundleDeclares } from '@/app/_authed/(extension-runtime)/_types'

/*
 * The provider points an extension's client bundle registers -- the keys of
 * its declaration's `provides` (apps, right-sidebar panels, markdown
 * resolvers, ...) -- and whether it declares settings pages, so the browser
 * imports a bundle only where one of them is shown or used, instead of every
 * bundle on every page.
 *
 * Read off the built bundle itself, the same `client.js` the browser imports:
 * it is evaluated once in a worker thread where the host, React and the common
 * browser globals are inert stubs, and the declaration it exports is read. A
 * source-text reading would have to guess what spreads, helpers and computed
 * keys evaluate to; this reads what they did.
 *
 * `null` means the answer could not be told, and the browser then loads the
 * bundle wherever any point or the settings menu is shown, as if it provided
 * all of them. That is the answer for a bundle that throws while it loads,
 * runs out of time, exports no declaration, or whose `provides` is anything
 * but a plain object of arrays or `settings` anything but an array -- and for
 * every bundle whose recorded answer was read from a
 * different `client.js` than the one being served. Being wrong in the other
 * direction would hide a panel, so every doubt resolves to "load it".
 *
 * Bound: a declaration that chooses its points from browser state while its
 * module loads (`...(localStorage.x ? { panels } : {})`) is read as the stubs
 * answer, which need not be what a browser answers. The client reports a
 * bundle that registers a point its listing did not name.
 */

const PROBE_TIMEOUT_MS = 5000

// A string, not a function's source: the app's own build may rewrite a
// function body with helpers that do not exist inside the worker.
//
// Every stub answers every property, call and `new` with another stub, so
// module-level code (`createContext()`, `class extends Component`, a library
// creating a DOM element to decode entities) runs to the end. `then` stays
// undefined so awaiting a stub settles. Enumerating a stub marks the reading
// unreliable: `{ ...stub }` copies nothing here and might copy points in a
// browser. Network globals throw, so nothing leaves the process.
const PROBE_WORKER = `
const { workerData, parentPort } = require('node:worker_threads')
const stubs = new WeakSet()
let enumeratedStub = false
function stub() {
  const proxy = new Proxy(function () {}, {
    get(target, key) {
      const own = Reflect.getOwnPropertyDescriptor(target, key)
      if (own && !own.configurable) return target[key]
      if (key === 'then') return undefined
      if (key === Symbol.toPrimitive) return () => ''
      if (key === Symbol.iterator) return function* () {}
      return stub()
    },
    ownKeys(target) {
      enumeratedStub = true
      return Reflect.ownKeys(target)
    },
    apply: () => stub(),
    construct: () => stub(),
  })
  stubs.add(proxy)
  return proxy
}
function namespace(known) {
  return new Proxy(known, {
    get: (target, key) => (key in target ? target[key] : key === 'then' ? undefined : stub()),
  })
}
function refused(name) {
  return () => {
    throw new Error(name + ' is not available while provider points are read')
  }
}
const browserGlobals = [
  'window', 'self', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'customElements', 'matchMedia', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'MutationObserver',
  'IntersectionObserver',
]
for (const name of browserGlobals) {
  Object.defineProperty(globalThis, name, { value: stub(), configurable: true, writable: true })
}
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  Object.defineProperty(globalThis, name, { value: refused(name), configurable: true, writable: true })
}
// The browser's API objects, key for key: \`legacy\` spreads them, so a key the
// stand-in lacked would be missing where the browser has one.
function api(keys, own) {
  return namespace(Object.assign(Object.fromEntries(keys.map((key) => [key, stub()])), own))
}
const defineExtension = (declaration) => declaration
globalThis.__extHost = {
  host: api(workerData.hostKeys, { defineExtension, icons: namespace({}) }),
  ui: api(workerData.uiKeys, {}),
  modules: Object.fromEntries(
    Object.entries(workerData.moduleKeys).map(([module, keys]) => [
      module,
      api(keys, module === 'extension' ? { defineExtension } : {}),
    ]),
  ),
}
async function read() {
  const module = await import(workerData.url)
  const declaration = module.default ?? module.extension
  if (!declaration || typeof declaration !== 'object' || stubs.has(declaration)) {
    throw new Error('the bundle exports no declaration')
  }
  const provides = declaration.provides ?? {}
  if (typeof provides !== 'object' || Array.isArray(provides) || stubs.has(provides)) {
    throw new Error('its provides is not a plain object')
  }
  const points = []
  for (const [point, items] of Object.entries(provides)) {
    if (!Array.isArray(items)) {
      throw new Error('provides.' + point + ' is not an array')
    }
    points.push(point)
  }
  const settings = declaration.settings ?? []
  if (!Array.isArray(settings)) {
    throw new Error('its settings is not an array')
  }
  if (enumeratedStub) {
    throw new Error('it enumerates a host value while it loads')
  }
  return { providedPoints: points.sort(), hasSettingsPages: settings.length > 0 }
}
read().then(
  (declares) => parentPort.postMessage(declares),
  (error) =>
    parentPort.postMessage({
      providedPoints: null,
      hasSettingsPages: null,
      reason: String((error && error.message) || error),
    }),
)
`

interface ProbeAnswer extends BundleDeclares {
  reason?: string
}

function notKnown(reason: string): ProbeAnswer {
  return { providedPoints: null, hasSettingsPages: null, reason }
}

/** Evaluates `bundleFile` in a worker and reads what its declaration shows; null fields where that cannot be told. */
export async function probeBundleDeclares(bundleFile: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeAnswer> {
  let api: ClientHostApi
  try {
    api = await loadClientHostApi()
  } catch (error) {
    return notKnown(`the host API did not load: ${String(error)}`)
  }
  return runProbe(
    bundleFile,
    {
      hostKeys: Object.keys(api.host),
      uiKeys: Object.keys(api.ui),
      moduleKeys: Object.fromEntries(
        Object.entries(api.modules).map(([module, value]) => [module, Object.keys(value)]),
      ),
    },
    timeoutMs,
  )
}

function runProbe(
  bundleFile: string,
  keys: { hostKeys: string[]; uiKeys: string[]; moduleKeys: Record<string, string[]> },
  timeoutMs: number,
): Promise<ProbeAnswer> {
  return new Promise((resolve) => {
    // Its own output is the bundle's console, not the server's. No inherited
    // flags: the app's loaders have no business inside it.
    const worker = new Worker(PROBE_WORKER, {
      eval: true,
      workerData: { url: pathToFileURL(bundleFile).href, ...keys },
      stdout: true,
      stderr: true,
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    const settle = (answer: ProbeAnswer) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      // A worker stays alive as long as anything it started does: a timer, a
      // pending promise. Ended here, whatever the bundle left behind.
      void worker.terminate()
      resolve(answer)
    }
    const timer = setTimeout(() => settle(notKnown(`it did not finish loading in ${timeoutMs} ms`)), timeoutMs)
    worker.on('message', (answer: ProbeAnswer) => settle(answer))
    worker.on('error', (error) => settle(notKnown(String(error))))
    worker.on('exit', (code) => settle(notKnown(`the probe exited with code ${code}`)))
  })
}

interface BundleDeclaresRecord extends BundleDeclares {
  /** The `client.js` mtime the answer was read from. */
  bundle: number
}

// A record missing a field, such as one written before the field was read, is
// not a record: the bundle is read again.
function isRecord(value: unknown): value is BundleDeclaresRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const { bundle, providedPoints, hasSettingsPages } = value as Record<string, unknown>
  return (
    typeof bundle === 'number' &&
    (providedPoints === null ||
      (Array.isArray(providedPoints) && providedPoints.every((point) => typeof point === 'string'))) &&
    (hasSettingsPages === null || typeof hasSettingsPages === 'boolean')
  )
}

async function readRecord(distDir: string): Promise<BundleDeclaresRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(distDir, PROVIDED_POINTS_FILE), 'utf-8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Distinguishes concurrent writes within one process; the pid distinguishes
// processes. Each record is written whole under its own name and renamed into
// place, so a reader sees one record or another, never a mix.
let writeCount = 0

/**
 * Reads what the client bundle in `distDir` declares and records it beside
 * it, with the bundle's identity. Never throws: a bundle with no record is
 * listed as undetermined.
 */
export async function recordBundleDeclares(distDir: string): Promise<void> {
  const bundleFile = path.join(distDir, 'client.js')
  const before = await statMaybe(bundleFile)
  if (before === 0) {
    return
  }
  const { reason, ...declares } = await probeBundleDeclares(bundleFile)
  // Replaced while it was read: the answer may be about either build.
  if ((await statMaybe(bundleFile)) !== before) {
    return
  }
  if (reason !== undefined) {
    console.warn(
      `[ext] ${path.basename(path.dirname(distDir))}: provider points not read (${reason}); its bundle loads wherever any point is used`,
    )
  }
  writeCount += 1
  const file = path.join(distDir, PROVIDED_POINTS_FILE)
  const temp = `${file}.${process.pid}.${writeCount}.tmp`
  const record: BundleDeclaresRecord = { bundle: before, ...declares }
  try {
    await fs.writeFile(temp, JSON.stringify(record))
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    console.error(`[ext] ${file}: provider points not recorded`, error)
  }
}

// One reading at a time, in the background: they are only ever needed for a
// bundle built before its points were recorded, and a listing does not wait.
const refreshing = new Set<string>()
let refreshQueue: Promise<void> = Promise.resolve()

function refreshInBackground(distDir: string): void {
  if (refreshing.has(distDir)) {
    return
  }
  refreshing.add(distDir)
  refreshQueue = refreshQueue
    .then(() => recordBundleDeclares(distDir))
    .catch((error: unknown) => console.error(`[ext] ${distDir}: provider points not read`, error))
    .finally(() => refreshing.delete(distDir))
}

const NOT_KNOWN: BundleDeclares = { providedPoints: null, hasSettingsPages: null }

/**
 * What the served client bundle of `extensionId` declares, with null fields
 * when that is not known for that exact bundle. Not knowing starts a reading,
 * so a later listing knows.
 */
export async function bundleDeclares(extensionId: string): Promise<BundleDeclares> {
  const distDir = extDistDir(extensionId)
  const [record, bundle] = await Promise.all([readRecord(distDir), statMaybe(path.join(distDir, 'client.js'))])
  if (bundle === 0) {
    return NOT_KNOWN
  }
  if (record?.bundle === bundle) {
    return { providedPoints: record.providedPoints, hasSettingsPages: record.hasSettingsPages }
  }
  refreshInBackground(distDir)
  return NOT_KNOWN
}
