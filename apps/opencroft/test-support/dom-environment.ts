// A DOM for tests that need to render React and then let it update.
//
// The test runner is plain Node, which has no `document`, so the usual option —
// `renderToStaticMarkup` — mounts once and never runs a layout effect. Anything
// whose behaviour only appears across renders (an effect that publishes, a
// state loop, a reconcile) is invisible to it. jsdom supplies the document
// `react-dom/client` needs to render, update, and re-render for real.
//
// Call this BEFORE importing anything that reaches react-dom: it binds to the
// globals present when first imported, so a static import at the top of a test
// file would capture the empty environment. Use `await import(...)` after.

export interface DomEnvironment {
  container: HTMLElement
  cleanup: () => void
}

export async function installDomEnvironment(): Promise<DomEnvironment> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    // A real origin. jsdom defaults the document to `about:blank`, whose
    // `location.origin` is the literal string "null" -- a state no served page
    // is ever in, and one that anything deriving a URL from the origin rejects.
    // The auth client is the case that found this: it deliberately takes no
    // baseURL so it addresses `/api/auth` on whatever origin served the page,
    // so importing it under `about:blank` threw before any test ran. Which host
    // this names is arbitrary; that it parses as an http origin is not.
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })

  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  globals.document = dom.window.document
  globals.HTMLElement = dom.window.HTMLElement
  globals.Element = dom.window.Element
  globals.Node = dom.window.Node
  // `navigator` is getter-only in Node, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  // Lets React accept `act()` for flushing work.
  globals.IS_REACT_ACT_ENVIRONMENT = true

  const container = dom.window.document.getElementById('root')
  if (!container) {
    throw new Error('dom environment: #root missing')
  }

  return {
    container: container as unknown as HTMLElement,
    cleanup: () => dom.window.close(),
  }
}
