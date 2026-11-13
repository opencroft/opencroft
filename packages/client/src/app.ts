/**
 * `@opencroft/client/app` — an App's client half: its component and form, its
 * pages and links, its place in the host's title bar and sidebar, and the URL
 * and breakpoint state a page reads.
 */
import type { AppEntry } from '@opencroft/core'
import type { ComponentProps, ComponentType, FC, ReactNode } from 'react'

/** Props the host passes to an App's component when rendering it in a space. */
export interface AppComponentProps {
  /** Which added instance is being rendered — matches the server hooks' `instanceId`. */
  instanceId: string
  spaceSlug: string
  /** The parameter values the user entered when adding the App, keyed by parameter id. */
  params: Record<string, string>
}

/**
 * Props the host passes to an App's custom parameter form. The form is
 * CONTROLLED: it renders `params` and reports every change through
 * `onChange`; the host owns the dialog, the submit button, and persistence.
 */
export interface AppFormProps {
  /** The space the instance is being added to (or lives in, when editing). */
  spaceSlug: string
  params: Record<string, string>
  onChange: (params: Record<string, string>) => void
}

/**
 * The client half of an App: the manifest's `provides.apps` entry plus the
 * React component. Declared under the same `apps` point in the client
 * `provides` of `defineExtension`, with the same bare `type`: the host
 * qualifies both with the extension's id and matches the two halves by it.
 */
export interface AppDefinition extends AppEntry {
  component: ComponentType<AppComponentProps>
  /**
   * Custom parameter form, replacing the host's generic one (which renders a
   * text input per declared manifest parameter). Declared `required`
   * parameters are still validated by the host on save.
   */
  form?: ComponentType<AppFormProps>
}

/**
 * Where an App is. An App's pages are real paths under its instance's address
 * (`/space/<space>/app/<app>/item/K-1`), and the App matches them itself;
 * everything here is App-relative, so an App never sees which space or slug it
 * was added under.
 *
 * The host draws its title bar and sidebars around every App page, except the
 * ones the App's manifest entry lists in `fullPageRoutes` (see `AppEntry` in
 * `@opencroft/core`): those fill the window alone — a print view, a
 * standalone preview — at the same address and behind the same sign-in.
 * `AppTitle`, `AppActions`, `AppToolbar` and `AppSidebar` show nothing there.
 */
export interface AppLocation {
  /** The App-relative path, e.g. `/item/K-1`; `/` at the instance's bare address. */
  path: string
  search: URLSearchParams
}

export interface AppNavigateOptions {
  /** Rewrite the current history entry instead of adding one. */
  replace?: boolean
}

/** The App's location; the caller re-renders on every move within the App. */
export declare const useAppLocation: () => AppLocation

/**
 * Resolves a `to` to the address it names, for an `href` or a copied link. A
 * `to` is an App path (`/item/K-1`, optionally with `?query`) or a bare query
 * (`?tab=activity`) for the page the App is on. Anything else throws: an App
 * addresses only its own pages.
 */
export declare const useAppHref: () => (to: string) => string

/**
 * Moves the App to `to` (see `useAppHref`) with a history entry, so back and
 * forward walk the App's pages. The App stays mounted and nothing scrolls.
 */
export declare const useAppNavigate: () => (to: string, options?: AppNavigateOptions) => void

/**
 * The address of a page of ANOTHER App instance, for an `href`: `address` is
 * its `<space>.<app>` (the address `app_call` takes), `to` an App path in it
 * (`/item/K-1`). For an App that lists things from other instances and links
 * to where each lives; the host owns what the page address looks like. Throws
 * on anything that is not such an address or path.
 */
export declare const useAppAddressHref: () => (address: string, to: string) => string

/**
 * Moves the host to a page of another App instance (see `useAppAddressHref`)
 * with a history entry, so Back returns here. Does nothing once the host is
 * already leaving the App.
 */
export declare const useOpenApp: () => (address: string, to: string, options?: AppNavigateOptions) => void

export interface AppLinkProps extends Omit<ComponentProps<'a'>, 'href'> {
  to: string
  replace?: boolean
}

/**
 * A link to one of the App's pages: a real `<a href>`, so a new tab, a new
 * window and copy link work on it, while a plain click moves the App in place.
 */
export declare const AppLink: FC<AppLinkProps>

/**
 * The App's heading in the title bar, after the space and App switchers:
 * `children` as the heading. Rendered where the App already is and sent into
 * the bar, so it follows the App's state and leaves with it.
 */
export declare const AppTitle: FC<{ children: ReactNode }>

/**
 * The App's actions, in the title bar's actions area. The bar folds on a
 * narrow screen, so keep them compact; a menu is a good fit for several.
 */
export declare const AppActions: FC<{ children: ReactNode }>

/** The App's tools, in a second row under the title bar that shows only while it has content. */
export declare const AppToolbar: FC<{ children: ReactNode }>

export interface AppSidebarProps {
  /**
   * How the sidebar sits beside the App on a wide screen. `push` (the default)
   * moves the whole App aside. `overlay` floats above the App's viewport
   * without moving it, while the App's UI area still makes room for the
   * sidebar, so nothing the App lays out lies under it; what the App renders
   * in `AppViewport` stays where it is and reaches under the sidebar. For
   * content with no edge to push, such as a canvas. On a phone the sidebar is
   * a sheet either way.
   */
  mode?: 'push' | 'overlay'
  children: ReactNode
}

/**
 * The App's panels, in the shell's left sidebar. While one is mounted the
 * title bar shows the button that opens and closes it.
 */
export declare const AppSidebar: FC<AppSidebarProps>

/**
 * Content that fills the App's whole viewport, behind the App's UI: the
 * App's content area including the strip an overlay sidebar lies over. It
 * stays put when that sidebar opens or closes, and when the App's own panels
 * move, so it is for what must not move with them, such as an endless canvas.
 * Rendered anywhere in the App, it fills the viewport all the same, as long
 * as no positioned element (`relative`, `absolute`, …) sits between it and the
 * App's root.
 *
 * The App's UI that overlaps it must stack above it: positioned, and later in
 * the page or with a z-index. What the App frames on it (fitting or centring a
 * view) belongs in the part its UI leaves uncovered.
 */
export declare const AppViewport: FC<{ children: ReactNode }>

export interface UrlParamWriteOptions {
  /**
   * Replace the current history entry instead of pushing a new one. Defaults
   * to `true`, so state that changes as often as the screen does does not make
   * the back button walk through it one step at a time.
   */
  replace?: boolean
}

export interface UrlParamControls {
  /** The current value, or `null` when the parameter is absent. */
  value: string | null
  /** Write the parameter, leaving every other parameter untouched. */
  set: (value: string, options?: UrlParamWriteOptions) => void
  /** Remove the parameter, leaving every other parameter untouched. */
  remove: (options?: UrlParamWriteOptions) => void
}

/** One URL search parameter, for state that should survive a reload. */
export declare const useUrlParam: (name: string) => UrlParamControls

/** The kit's mobile breakpoint, the same signal the host's own chat dock reads. */
export declare const useIsMobile: () => boolean
