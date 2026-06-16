'use client'

import * as icons from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { Badge } from 'ui/badge'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'
import { Separator } from 'ui/separator'
import { Textarea } from 'ui/textarea'

import { NodeFrame } from '@/app/(dashboard)/_canvas/node-frame'
import {
  extensionStorageClear,
  extensionStorageDelete,
  extensionStorageGet,
  extensionStorageList,
  extensionStorageSet,
} from '@/app/(dashboard)/_extension-system/extension-storage'
import { useNodeContext } from '@/app/(dashboard)/_extension-system/use-node-context'
import { defineExtension } from '@/app/(extension-runtime)/_client/host'
import {
  copyKeyToWsl,
  createKey,
  deleteKey,
  importKey,
  listKeys,
  readPublicKey,
  removeKeyFromWsl,
} from '@/app/(legacy-app-dashboard)/_legacy/nodes/key-store/actions'
import { deleteSecret, getSecrets, setSecret } from '@/app/(secrets-store)/_server/actions'
import { ControlledInput } from '@/components/ui/input/controlled-input'

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

export function createStorage(extensionId: string): ExtensionStorage {
  return {
    get: (key) => extensionStorageGet({ data: { extensionId, key } }),
    set: (key, value) => extensionStorageSet({ data: { extensionId, key, value } }),
    delete: (key) => extensionStorageDelete({ data: { extensionId, key } }),
    list: () => extensionStorageList({ data: extensionId }),
    clear: () => extensionStorageClear({ data: extensionId }),
  }
}

export const ui = {
  Badge,
  Button,
  ControlledInput,
  Flex,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Textarea,
}

export const actions = {
  keyStore: {
    listKeys,
    createKey,
    importKey,
    deleteKey,
    readPublicKey,
    copyKeyToWsl,
    removeKeyFromWsl,
  },
  secretsStore: {
    getSecrets,
    setSecret,
    deleteSecret,
  },
}

export interface ExtensionApi {
  React: typeof React
  defineExtension: typeof defineExtension
  NodeFrame: typeof NodeFrame
  useNodeContext: typeof useNodeContext
  icons: typeof icons
  createStorage: typeof createStorage
  ui: typeof ui
  actions: typeof actions
  toast: typeof toast
}

export const extensionApi: ExtensionApi = {
  React,
  defineExtension,
  NodeFrame,
  useNodeContext,
  icons,
  createStorage,
  ui,
  actions,
  toast,
}

declare global {
  interface Window {
    __extensionApi?: ExtensionApi
  }
}

export function installExtensionApi(): void {
  if (typeof window !== 'undefined') {
    window.__extensionApi = extensionApi
  }
}
