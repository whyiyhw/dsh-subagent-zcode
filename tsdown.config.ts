import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  platform: 'node',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  // Peer-provided packages resolve from the dsh installation at plugin load
  // time (profile module-fallback); bundling them in would duplicate the
  // single module instance the harness shares across plugins.
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
