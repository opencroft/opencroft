/** `@opencroft/server/extension` — the extension's own identity and URLs. */

/** The extension's own id, `<owner>.<extension>`. Never hard-code it. */
export declare const extensionId: string

/**
 * Where the host serves this extension: `/api/ext/<extensionId>`. Extensions
 * never build their own URLs — use this, `assetUrl`, `routeUrl` and
 * `absoluteUrl`, so a link stays right when the extension is served under
 * another folder or the URL scheme changes.
 */
export declare const urlBase: string

/** The URL of a static file under the extension's `assets/` folder. */
export declare const assetUrl: (path: string) => string

/** The URL of one of the extension's declared HTTP `routes` (see `ExtensionRoute`). */
export declare const routeUrl: (path: string) => string

/**
 * An instance-relative URL (`urlBase`, or what `assetUrl` / `routeUrl`
 * return) in absolute form, for a link handed outside the instance: a
 * webhook target, a registry entry in another project's config.
 *
 * There is no instance-origin setting, so the origin is the one `request`
 * arrived on — pass the request the handler is answering. From code with no
 * request in hand, keep the relative URL and let the client make it
 * absolute (the client's `absoluteUrl` uses the page's origin).
 */
export declare const absoluteUrl: (request: Request, url?: string) => string
