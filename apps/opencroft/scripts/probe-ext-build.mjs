import path from 'node:path'

import * as esbuild from 'esbuild'

const extRoot = 'w:/Projects/React/opencroft/app/(extension-runtime)/_builtin/core'
const projectNodeModules = 'w:/Projects/React/opencroft/node_modules'

const stubPlugin = {
  name: 'ext-stubs',
  setup(build) {
    build.onResolve({ filter: /^@ext\/(host|ui)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const __stub = {}; export default {};',
      loader: 'js',
    }))
  },
}

try {
  const result = await esbuild.build({
    entryPoints: [path.join(extRoot, 'src/client.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    outfile: '/tmp/probe-client.js',
    absWorkingDir: extRoot,
    nodePaths: [path.join(extRoot, 'node_modules'), projectNodeModules],
    plugins: [stubPlugin],
    logLevel: 'silent',
    write: false,
  })
  console.log('OK warnings:', result.warnings.length)
  for (const w of result.warnings) {
    console.log('  W', w.location?.file, w.location?.line, w.text)
  }
} catch (err) {
  console.log('FAILED')
  const bf = err
  if (bf.errors) {
    for (const e of bf.errors) {
      console.log('  E', e.location?.file, e.location?.line, '-', e.text)
    }
  } else {
    console.log(err)
  }
}
