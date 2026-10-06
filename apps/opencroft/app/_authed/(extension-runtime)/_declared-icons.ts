/**
 * Every icon name an extension's manifest or declaration carries: the string
 * `icon` of any entry, however deeply it sits -- a node, an app, an inspector
 * tab, a settings page, a command mode, a context-menu item, a provided panel.
 *
 * Read generically rather than field by field so a new place an extension can
 * name an icon is covered without being listed here. Only plain objects and
 * arrays are walked: components and other class instances are not data.
 */
export function declaredIconNames(value: unknown): string[] {
  const names = new Set<string>()
  const seen = new Set<object>()
  const walk = (item: unknown) => {
    if (typeof item !== 'object' || item === null || seen.has(item)) {
      return
    }
    seen.add(item)
    if (Array.isArray(item)) {
      item.forEach(walk)
      return
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) {
      return
    }
    for (const [key, child] of Object.entries(item)) {
      if (key === 'icon' && typeof child === 'string' && child !== '') {
        names.add(child)
      } else {
        walk(child)
      }
    }
  }
  walk(value)
  return [...names]
}
