import { watch } from 'node:fs';


import { buildExtension } from '@/app/(extension-runtime)/_server/compiler';
import { listAllExtensionIds, readManifest } from '@/app/(extension-runtime)/_server/manifest';
import { extDir } from '@/app/(extension-runtime)/_server/paths';

const DEBOUNCE_MS = 300;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function rebuild(extensionId: string) {
  const label = `[${extensionId}]`;
  try {
    const manifest = await readManifest(extensionId);
    const result = await buildExtension(extensionId, manifest);
    if (result.success) {
      console.log(`${label} compiled ✓`);
    } else {
      for (const e of result.errors) {
        console.error(`${label} ${e.file}:${e.line ?? '?'}  ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`${label} build failed:`, err);
  }
}

function watchDir(dir: string, extensionId: string) {
  try {
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        return;
      }
      const rel = filename.toString();
      if (rel.startsWith('dist') || rel.includes('node_modules')) {
        return;
      }
      const prev = timers.get(extensionId);
      if (prev) {
        clearTimeout(prev);
      }
      timers.set(extensionId, setTimeout(() => {
        timers.delete(extensionId);
        console.log(`[${extensionId}] change: ${rel}`);
        rebuild(extensionId);
      }, DEBOUNCE_MS));
    });
    console.log(`watching ${extensionId}`);
  } catch (err) {
    console.error(`failed to watch ${extensionId}:`, err);
  }
}

async function main() {
  const ids = await listAllExtensionIds();
  const builtinIds = ids.filter((id) => id.startsWith('builtin/'));

  // Initial build
  for (const id of builtinIds) {
    await rebuild(id);
  }

  // Watch
  for (const id of builtinIds) {
    watchDir(extDir(id), id);
  }

  console.log(`\n> Watching ${builtinIds.length} builtin extensions for changes\n`);
}

main();
