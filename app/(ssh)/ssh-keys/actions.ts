import { createServerFn } from '@tanstack/react-start';

import { sshKeys } from '@/app/(server)/server/ssh-key';

export const listSshKeys = createServerFn().handler(async () => {
  return sshKeys.list();
});

export const getPublicKey = createServerFn({ method: 'POST' })
  .inputValidator((keyPath: string) => keyPath)
  .handler(async ({ data: keyPath }) => {
    return sshKeys.readPublicKey(keyPath);
  });

export const createSshKey = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; keyType: string }) => data)
  .handler(async ({ data }) => {
    const { name, keyType } = data;
    return sshKeys.create(name, keyType);
  });

export const importSshKey = createServerFn({ method: 'POST' })
  .inputValidator((data: { name: string; content: string }) => data)
  .handler(async ({ data }) => {
    const { name, content } = data;
    return sshKeys.import(name, content);
  });

export const deleteSshKey = createServerFn({ method: 'POST' })
  .inputValidator((keyPath: string) => keyPath)
  .handler(async ({ data: keyPath }) => {
    return sshKeys.delete(keyPath);
  });

export const copyKeyToWsl = createServerFn({ method: 'POST' })
  .inputValidator((data: { keyPath: string; name: string }) => data)
  .handler(async ({ data }) => {
    const { keyPath, name } = data;
    return sshKeys.copyToWsl(keyPath, name);
  });

export const removeKeyFromWsl = createServerFn({ method: 'POST' })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }) => {
    return sshKeys.removeFromWsl(name);
  });
