import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';

const isWindows = os.platform() === 'win32';

export function setPermissions(filePath: string): Promise<void> {
  if (!isWindows) {
    return fs.chmod(filePath, 0o600);
  }
  return new Promise((resolve, reject) => {
    execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
