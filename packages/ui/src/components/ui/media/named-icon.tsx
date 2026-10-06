'use client'

import { Icon, type LucideIcon, type LucideProps } from 'lucide-react'
// `.mjs` named outright: the package has no export map, and Node does not add
// extensions to a subpath, so the bare `lucide-react/dynamic` reaches a file
// Node cannot read as a module.
import { dynamicIconImports, iconNames } from 'lucide-react/dynamic.mjs'
// The default import carries `use`; a named import of it is undefined wherever
// React is supplied through a shim that lists its exports by hand (an
// extension's or a design-kit preview's), and the default is the whole object
// in every one of them.
import React, { forwardRef, Suspense } from 'react'

/**
 * Every Lucide icon by name, loaded one icon at a time.
 *
 * A name is the icon's kebab-case name (`arrow-right`, the one lucide.dev and
 * the icon's CSS class use) or any of its `lucide-react` export names
 * (`ArrowRight`, `ArrowRightIcon`, `LucideArrowRight`), renamed icons' old names
 * included. Each icon is its own chunk, fetched the first time something asks
 * for it, so a page carries the icons it draws rather than all of them.
 *
 * While an icon loads, its place is held by an empty icon of the same size and
 * class, so nothing moves when it arrives. The icon renders inside its own
 * Suspense boundary, which is what keeps server-rendered markup in place while
 * the client fetches the same icon during hydration. An icon that was preloaded
 * (`preloadIcons`) draws on the first render.
 */

type IconKey = keyof typeof dynamicIconImports

/** The kebab-case name of every icon Lucide ships, renamed icons' old names included. */
export const ICON_NAMES: readonly string[] = iconNames

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

// `lucide-react` names each export after the kebab name the same way, so the
// map can be derived rather than shipped.
const keyByExportName = new Map<string, IconKey>(iconNames.map((name) => [pascalCase(name), name]))

/**
 * Every `lucide-react` export name of every icon: `ArrowRight`,
 * `ArrowRightIcon` and `LucideArrowRight` for `arrow-right`, and the same three
 * for each renamed icon's old name.
 */
export function iconExportNames(): string[] {
  return [...keyByExportName.keys()].flatMap((name) => [name, `${name}Icon`, `Lucide${name}`])
}

/**
 * The kebab-case name `name` refers to, or undefined when Lucide has no such
 * icon. Accepts the kebab-case name and every export name of the icon.
 */
export function iconKey(name: string): IconKey | undefined {
  if (Object.hasOwn(dynamicIconImports, name)) {
    return name as IconKey
  }
  return keyByExportName.get(name) ?? keyByExportName.get(name.replace(/^Lucide/, '').replace(/Icon$/, ''))
}

type IconLoad = Promise<LucideIcon | null>

const loads = new Map<IconKey, IconLoad>()

function loadIcon(key: IconKey): IconLoad {
  const existing = loads.get(key)
  if (existing) {
    return existing
  }
  const load: IconLoad = dynamicIconImports[key]().then(
    (module) => module.default,
    () => {
      // A chunk that failed to arrive is asked for again by the next render
      // that needs it; this one draws the fallback.
      loads.delete(key)
      return null
    },
  )
  // Marked the way React's `use` reads a settled promise, so a render that
  // comes after it has arrived takes it synchronously instead of suspending.
  void load.then((value) => {
    Object.assign(load, { status: 'fulfilled', value })
  })
  loads.set(key, load)
  return load
}

/**
 * Fetch these icons now, so that whatever draws them later draws them on its
 * first render. Names Lucide doesn't have are skipped. Resolves when every
 * known icon has arrived or failed.
 */
export async function preloadIcons(names: Iterable<string>): Promise<void> {
  const keys = new Set<IconKey>()
  for (const name of names) {
    const key = iconKey(name)
    if (key) {
      keys.add(key)
    }
  }
  await Promise.all([...keys].map(loadIcon))
}

/** An icon with nothing drawn in it: the size and class of any other, and blank. */
const BlankIcon: LucideIcon = forwardRef((props, ref) => <Icon ref={ref} iconNode={[]} {...props} />)
BlankIcon.displayName = 'BlankIcon'

interface LoadedIconProps extends LucideProps {
  load: IconLoad
  fallback: LucideIcon
}

const LoadedIcon = forwardRef<SVGSVGElement, Omit<LoadedIconProps, 'ref'>>(
  ({ load, fallback: Fallback, ...props }, ref) => {
    const Loaded = React.use(load) ?? Fallback
    return <Loaded ref={ref} {...props} />
  },
)
LoadedIcon.displayName = 'LoadedIcon'

export interface NamedIconProps extends LucideProps {
  /** The icon's kebab-case name or any of its `lucide-react` export names. */
  name: string
  /** Drawn in place of a name Lucide doesn't have. Defaults to a blank icon. */
  fallback?: LucideIcon
}

/** A Lucide icon by name, loaded on first use. Takes every prop a Lucide icon takes. */
export const NamedIcon = forwardRef<SVGSVGElement, Omit<NamedIconProps, 'ref'>>(
  ({ name, fallback = BlankIcon, ...props }, ref) => {
    const key = iconKey(name)
    const Fallback = fallback
    if (!key) {
      return <Fallback ref={ref} {...props} />
    }
    return (
      <Suspense fallback={<BlankIcon ref={ref} {...props} />}>
        <LoadedIcon ref={ref} load={loadIcon(key)} fallback={fallback} {...props} />
      </Suspense>
    )
  },
)
NamedIcon.displayName = 'NamedIcon'

const componentsByFallback = new Map<LucideIcon, Map<string, LucideIcon>>()

/**
 * The icon `name` as a component of its own, for an API that hands out icon
 * components rather than names. The same name and fallback always give back
 * the same component, so React never sees a new element type for one icon.
 */
export function iconComponent(name: string, fallback: LucideIcon = BlankIcon): LucideIcon {
  let components = componentsByFallback.get(fallback)
  if (!components) {
    components = new Map()
    componentsByFallback.set(fallback, components)
  }
  let component = components.get(name)
  if (!component) {
    component = forwardRef((props, ref) => <NamedIcon ref={ref} name={name} fallback={fallback} {...props} />)
    component.displayName = pascalCase(iconKey(name) ?? name)
    components.set(name, component)
  }
  return component
}
