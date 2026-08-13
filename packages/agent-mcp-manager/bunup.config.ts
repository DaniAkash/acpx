import { defineConfig } from 'bunup'

export default defineConfig({
  entry: ['src/index.ts', 'src/lowlevel.ts'],
  format: ['esm'],
  target: 'node',
  dts: true,
  clean: true,
  external: ['@iarna/toml', 'jsonc-parser', 'yaml'],
})
