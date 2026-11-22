import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Playground для e2e realtime-коллаборации. Раздаёт SPA на :5173 и проксирует
// /api/vaulter + /e2e на живой testbench-хост (:8000). @vaulter/vue резолвится прямо
// из исходников пакета — тестируем то, что реально шипается, без шага сборки.
const backend = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@vaulter/vue': fileURLToPath(new URL('../packages/vue/src/index.ts', import.meta.url)),
    },
    // Один экземпляр yjs/vue на всё дерево (provider + редактор), иначе CRDT не сойдётся.
    dedupe: ['yjs', 'vue', '@tiptap/pm'],
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/e2e': { target: backend, changeOrigin: false },
    },
  },
})
