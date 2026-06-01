'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type { NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { loadTemplates, saveTemplates } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/actions'
import { compileTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/compiler'
import type { CustomTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/types'

interface CustomTemplatesContextValue {
  templates: CustomTemplate[]
  definitions: NodeTypeDefinition[]
  upsertTemplate: (template: CustomTemplate) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
}

const CustomTemplatesContext = createContext<CustomTemplatesContextValue>({
  templates: [],
  definitions: [],
  upsertTemplate: async () => {},
  deleteTemplate: async () => {},
})

export function CustomTemplatesProvider({ children }: { children: React.ReactNode }) {
  const [templates, setTemplates] = useState<CustomTemplate[]>([])

  useEffect(() => {
    loadTemplates().then(setTemplates)
  }, [])

  const definitions = useMemo(
    () =>
      templates.flatMap((t) => {
        const def = compileTemplate(t)
        return def ? [def] : []
      }),
    [templates],
  )

  const upsertTemplate = useCallback(
    async (template: CustomTemplate) => {
      const exists = templates.some((t) => t.id === template.id)
      const next = exists ? templates.map((t) => (t.id === template.id ? template : t)) : [...templates, template]
      setTemplates(next)
      await saveTemplates({ data: next })
    },
    [templates],
  )

  const deleteTemplate = useCallback(
    async (id: string) => {
      const next = templates.filter((t) => t.id !== id)
      setTemplates(next)
      await saveTemplates({ data: next })
    },
    [templates],
  )

  return <CustomTemplatesContext.Provider value={{ templates, definitions, upsertTemplate, deleteTemplate }}>{children}</CustomTemplatesContext.Provider>
}

export function useCustomTemplates() {
  return useContext(CustomTemplatesContext)
}
