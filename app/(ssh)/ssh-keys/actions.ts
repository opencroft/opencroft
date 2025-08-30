'use server';

import { sshKeys } from '@/app/(server)/server/ssh-key';

export async function listSshKeys() {
  return sshKeys.list();
}

export async function getPublicKey(keyPath: string) {
  return sshKeys.readPublicKey(keyPath);
}

export async function createSshKey(name: string, keyType: string) {
  return sshKeys.create(name, keyType);
}

export async function importSshKey(name: string, content: string) {
  return sshKeys.import(name, content);
}

export async function deleteSshKey(keyPath: string) {
  return sshKeys.delete(keyPath);
}

export async function copyKeyToWsl(keyPath: string, name: string) {
  return sshKeys.copyToWsl(keyPath, name);
}

export async function removeKeyFromWsl(name: string) {
  return sshKeys.removeFromWsl(name);
}
