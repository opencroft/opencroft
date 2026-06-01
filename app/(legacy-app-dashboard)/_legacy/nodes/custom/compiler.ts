'use client'

import { useReactFlow } from '@xyflow/react'
import * as LucideIcons from 'lucide-react'
import * as React from 'react'

import type { NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { useSettingsDraft } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/use-settings-draft'
import type { CustomTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/types'
import { runScript } from '@/app/(legacy-app-dashboard)/_legacy/nodes/script/actions'
import { ButtonPin, HANDLE_EXECUTION, HANDLE_FILESYSTEM } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/button-pin'
import { PinnedNode } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/pinned-node'
import { spawnFileBrowserWindow, spawnTerminalWindow } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/spawn-window'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const SCOPE = {
  React,
  h: React.createElement,
  useState: React.useState,
  useCallback: React.useCallback,
  useEffect: React.useEffect,
  useRef: React.useRef,
  useMemo: React.useMemo,
  useReactFlow,
  useSettingsDraft,
  icons: LucideIcons,
  PinnedNode,
  ButtonPin,
  HANDLE_EXECUTION,
  HANDLE_FILESYSTEM,
  runScript,
  spawnTerminalWindow,
  spawnFileBrowserWindow,
  ui: { Button, Input, Label, Textarea },
}

export function compileTemplate(template: CustomTemplate): NodeTypeDefinition | null {
  try {
    const fn = new Function(...Object.keys(SCOPE), `"use strict";\n${template.code}`)
    const result = fn(...Object.values(SCOPE)) as Partial<NodeTypeDefinition> & { color?: string }
    if (!result || typeof result !== 'object') {
      return null
    }
    return {
      type: `custom-${template.id}`,
      label: result.label ?? template.name,
      icon: result.icon ?? LucideIcons.Box,
      group: result.group ?? 'Custom',
      defaultData: result.defaultData ?? (() => ({})),
      component: result.component!,
      settings: result.settings ?? (() => null),
    }
  } catch (e) {
    console.error(`Failed to compile template "${template.name}":`, e)
    return null
  }
}
