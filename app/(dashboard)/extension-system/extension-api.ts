'use client';

import * as icons from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { NodeFrame } from '@/app/(dashboard)/_canvas/node-frame';
import {
  extensionStorageClear,
  extensionStorageDelete,
  extensionStorageGet,
  extensionStorageList,
  extensionStorageSet,
} from '@/app/(dashboard)/extension-system/extension-storage';
import { useNodeContext } from '@/app/(dashboard)/extension-system/use-node-context';
import { defineExtension } from '@/app/(extension-runtime)/_client/host';
import {
  copyKeyToWsl,
  createKey,
  deleteKey,
  importKey,
  listKeys,
  readPublicKey,
  removeKeyFromWsl,
} from '@/app/(legacy-app-dashboard)/nodes/key-store/actions';
import {
  deleteSecret,
  getSecrets,
  setSecret,
} from '@/app/(secrets-store)/secrets-store/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ControlledInput } from '@/components/ui/input/controlled-input';
import { Label } from '@/components/ui/label';
import { Flex } from '@/components/ui/layout/flex';
import { ScrollArea } from '@/components/ui/layout/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
  clear(): Promise<void>;
}

export function createStorage(extensionId: string): ExtensionStorage {
  return {
    get: (key) => extensionStorageGet(extensionId, key),
    set: (key, value) => extensionStorageSet(extensionId, key, value),
    delete: (key) => extensionStorageDelete(extensionId, key),
    list: () => extensionStorageList(extensionId),
    clear: () => extensionStorageClear(extensionId),
  };
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
};

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
};

export interface ExtensionApi {
  React: typeof React;
  defineExtension: typeof defineExtension;
  NodeFrame: typeof NodeFrame;
  useNodeContext: typeof useNodeContext;
  icons: typeof icons;
  createStorage: typeof createStorage;
  ui: typeof ui;
  actions: typeof actions;
  toast: typeof toast;
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
};

declare global {
  interface Window {
    __extensionApi?: ExtensionApi;
  }
}

export function installExtensionApi(): void {
  if (typeof window !== 'undefined') {
    window.__extensionApi = extensionApi;
  }
}
