'use client'

import { useEffect, useId, useState } from 'react'
import { cn } from 'cn'

// mermaid is loaded through a dynamic import inside the effect below, never at
// module scope. The package unpacks to 124 MB and still costs on the order of
// a megabyte gzipped in the browser once a bundler has given it a chunk of its
// own, while the great majority of conversations contain no diagram in them at
// all. At module scope that weight attaches to the chat itself, so a reader
// who was only ever shown text would have paid to render diagrams they never
// saw -- a defect rather than a trade-off. Fetching it when the first diagram
// appears puts the cost where there is something to show for it.

/**
 * What the component has to show right now. `pending` and `failed` render the
 * same fallback on purpose -- see the end of the component.
 */
type RenderState =
  | { status: 'pending' }
  | { status: 'rendered'; svg: string }
  | { status: 'failed'; message: string }

// Tracks the shadcn dark-mode convention (a `dark` class on <html>) via a
// MutationObserver, rather than depending on a theming library -- this stays
// usable by any host regardless of how it wires up theme switching.
function useIsDarkMode(): boolean {
  // Guarded because this initializer runs during render, which on a
  // server-rendered host means it runs where there is no `document` -- and the
  // failure is the whole route dying, not a diagram drawn in the wrong
  // palette. Starting light and correcting in the effect below costs one
  // client-side update.
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

export interface MermaidDiagramProps {
  /** The diagram source, exactly as it was written inside the fenced block. */
  chart: string
  /**
   * Added to the wrapper. For the width constraints and clamps a particular
   * surface needs -- the diagram's own colours come from the mermaid theme,
   * which is chosen below and is deliberately not stylable from here.
   */
  className?: string
}

/**
 * A mermaid diagram, rendered from its source.
 *
 * Presentational and fully controlled: it is handed the text of a `mermaid`
 * fenced block and turns it into a picture. It fetches nothing, owns no
 * conversation state, and never rewrites the source it was given.
 */
export function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const [state, setState] = useState<RenderState>({ status: 'pending' })
  const dark = useIsDarkMode()
  const reactId = useId()

  // mermaid draws into an element it creates under this id and then looks that
  // element back up by selector, so the id has to be a legal one -- and it has
  // to differ per instance, because two diagrams sharing an id in a single
  // transcript would render over each other. useId supplies the uniqueness;
  // the punctuation React wraps it in (`:r1:`, or `«r1»` depending on the
  // version) is not legal in a selector, so it is stripped here rather than
  // the uniqueness being reinvented with a module-level counter -- which would
  // not survive two React roots on one page.
  const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    // `mermaid.render` is asynchronous twice over -- the import, then the
    // parse -- so a result can arrive after this component has gone away, or
    // after `chart` has changed underneath it. Anything that comes back for a
    // superseded run is dropped instead of being written into state.
    let live = true

    // Note what this effect does NOT do: it never puts the state back to
    // `pending` on the way in. While a redraw is in flight the diagram already
    // on screen stays there, so a theme switch does not blink the picture out
    // and back, and a diagram being edited does not drop to its own source for
    // a frame every time the text changes.
    const draw = async () => {
      try {
        const mermaid = (await import('mermaid')).default
        // The theme is not an argument to `render`: mermaid holds a single
        // global configuration, so it has to be re-established before each
        // one. Doing it here rather than once at startup is also what lets a
        // diagram follow a theme switch -- `dark` is a dependency of this
        // effect, so flipping it redraws in the other palette.
        mermaid.initialize({
          startOnLoad: false,
          // This source was written by an agent. Left any looser, mermaid
          // honours `click` directives and renders label text as raw HTML,
          // which turns a diagram into a way for whatever produced it to run
          // script in the reader's page.
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        })
        const { svg } = await mermaid.render(id, chart)
        if (live) {
          setState({ status: 'rendered', svg })
        }
      } catch (error) {
        // mermaid draws into a node it appends to the document and takes away
        // again on its way out; when the parse throws, that node can be left
        // behind. A syntax error is an ordinary event here rather than an
        // exceptional one, so the leftovers would otherwise accumulate at one
        // per failed diagram.
        document.getElementById(id)?.remove()
        document.getElementById(`d${id}`)?.remove()
        if (live) {
          setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    draw()

    return () => {
      live = false
    }
  }, [chart, dark, id])

  if (state.status === 'rendered') {
    // The render result also offers `bindFunctions`, which attaches the
    // handlers a diagram's `click` directives ask for. It is deliberately
    // never called -- under `securityLevel: 'strict'` those directives are
    // inert anyway, and this is precisely the kind of source that should not
    // be able to install a handler.
    return (
      <div
        className={cn('min-w-0 max-w-full overflow-x-auto', className)}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a string of SVG is the only thing mermaid produces, and mounting it is the only thing that can be done with it. The exposure this rule guards against is closed where the markup is made rather than here -- `securityLevel: 'strict'` above makes mermaid escape label text instead of passing it through as HTML and leaves `click` directives inert, so agent-authored source cannot arrive at this line as markup. What would retire this suppression: mermaid gaining a way to hand back a node instead of a string, or the security level being relaxed -- and the second one makes the rule right again rather than this comment wider.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  // One fallback serves both a diagram that has not rendered yet and one that
  // never will. To a reader those are the same situation -- there is no
  // picture -- and in both the source is the best thing to put in its place: a
  // blank box says nothing at all, and since these diagrams are written by
  // agents a syntax error is a normal occurrence rather than a rare one.
  // Sharing the markup also means the failure path is the one every diagram
  // exercises on its first paint, instead of being the branch nobody sees
  // until it is needed.
  return (
    <div className={cn('min-w-0 max-w-full', className)}>
      <pre className='overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs'>
        <code>{chart}</code>
      </pre>
      {state.status === 'failed' ? <p className='mt-1 text-xs text-muted-foreground'>{state.message}</p> : null}
    </div>
  )
}
