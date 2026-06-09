import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProfilesFile } from 'agent-client/profiles'

import type { ProfilesStore } from './runtime'

// Default profiles store: a JSON file next to agent-config.json / mcp-config.json
// in the server's working directory (all gitignored).
const PROFILES_PATH = join(process.cwd(), 'agent-profiles.json')

export const fileProfilesStore: ProfilesStore = {
  async read(): Promise<ProfilesFile> {
    try {
      const data = JSON.parse(await readFile(PROFILES_PATH, 'utf8')) as ProfilesFile
      if (Array.isArray(data.profiles)) {
        return data
      }
    } catch {
      // Missing or malformed file → start empty.
    }
    return { profiles: [], activeProfileId: '' }
  },

  async write(data: ProfilesFile): Promise<void> {
    await writeFile(PROFILES_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  },
}
