'use client'

import React, { useEffect, useState } from 'react'
import { extensionPageId as pageMenuId } from 'ui/settings/extension-settings-menu'

import type { SettingsPageDefinition } from '@/app/_authed/(extension-runtime)/_client/host'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import {
  extensionRegistry,
  type ResolvedExtensionSettings,
  resolveIcon,
} from '@/app/_authed/(extension-runtime)/_client/registry'

// The menu UI itself lives in the design kit (ui/settings/extension-settings-menu);
// what stays here is everything that knows about the extension runtime: loading
// the extensions, resolving their settings, and turning a resolved list into the
// plain-data entries the kit menu renders.

// The menu id of an extension's page, re-exported from the kit so the two never
// drift apart.
export { pageMenuId }

export function findExtensionPage(
  settings: ResolvedExtensionSettings[],
  activeId: string,
): SettingsPageDefinition | null {
  for (const entry of settings) {
    for (const page of entry.pages) {
      if (pageMenuId(entry.extensionId, page.id) === activeId) {
        return page
      }
    }
  }
  return null
}

// Turns resolved extension settings into the plain-data entries the kit menu
// renders: ids, labels, and icons already resolved to components.
export function extensionMenuEntries(settings: ResolvedExtensionSettings[]) {
  return settings.map((entry) => ({
    extensionId: entry.extensionId,
    extensionName: entry.extensionName,
    pages: entry.pages.map((page) => ({
      id: page.id,
      label: page.label,
      icon: resolveIcon(page.icon),
    })),
  }))
}

export function useExtensionSettings(): ResolvedExtensionSettings[] {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    loadAllExtensions().then(() => setVersion((v) => v + 1))
  }, [])
  return React.useMemo(() => {
    void version
    return extensionRegistry.allSettings()
  }, [version])
}
