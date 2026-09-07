// One App of the catalog, written as `<extension-slug>.<app-slug>` — the
// format the add-app page's search param carries. The extension slug is the
// extension id's tail: ids are `<source>/<slug>`, and the source is packaging
// rather than identity, so a URL does not carry it.

export function appRefFor(app: { extensionId: string; slug: string }): string {
  return `${extensionSlugOf(app.extensionId)}.${app.slug}`
}

export function findAppByRef<T extends { extensionId: string; slug: string }>(apps: T[], ref: string): T | undefined {
  return apps.find((app) => appRefFor(app) === ref)
}

function extensionSlugOf(extensionId: string): string {
  return extensionId.split('/').pop() ?? extensionId
}
