import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'

// Library build: type-check + emit declarations, externalize Vue, the host's @vaulter/vue and the
// realtime stack (yjs, @hocuspocus/provider), ship ES + UMD bundles. @vaulter/vue is imported for
// types only: nothing of it reaches the bundle.
export default defineConfig({
  plugins: [
    dts({ tsconfigPath: './tsconfig.json', include: ['src'], exclude: ['tests'] }),
  ],
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      name: 'VaulterVueCollaboration',
      fileName: 'vaulter-vue-collaboration',
    },
    rollupOptions: {
      external: ['vue', 'yjs', /^@hocuspocus\//, /^@vaulter\//],
      output: {
        exports: 'named',
        globals: {
          'vue': 'Vue',
          'yjs': 'Y',
          '@hocuspocus/provider': 'Hocuspocus',
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
