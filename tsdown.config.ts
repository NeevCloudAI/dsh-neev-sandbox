import { defineConfig } from 'tsdown'

// Two Loader entry points; each default-exports one Cordis Service class.
export default defineConfig({
  entry: ['src/runtime.ts', 'src/subprocess/index.ts', 'src/filesystem/index.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  clean: true,
  // Emit .js/.d.ts (not .mjs) so package exports and the dsh loader resolve.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
