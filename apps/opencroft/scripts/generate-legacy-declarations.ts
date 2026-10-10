// Writes the deprecated extension API declarations (the `legacy` namespaces and
// the `@ext/host` / `@ext/ui` typings) from the API modules and the host's
// runtime surface. See legacy-declarations.ts for what they are.
//
// Reading the runtime surface loads the client host, whose imports open the
// database; the tests' throwaway one keeps that off this checkout's data. Its
// components need the test runner's JSX transform, which is why the npm script
// names tsconfig.test.json.
import '@opencroft/db/test-env'

import { writeFileSync } from 'node:fs'

const { renderLegacyDeclarations, repoPath } = await import(
  '@/app/_authed/(extension-runtime)/_server/legacy-declarations'
)

for (const file of renderLegacyDeclarations()) {
  writeFileSync(repoPath(file.path), file.content)
  console.log(`wrote ${file.path}`)
}
process.exit(0)
