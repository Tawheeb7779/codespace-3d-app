import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    // Two chunks are deliberately large and lazily loaded: the Monaco core
    // (~3.7 MB) on the first editor mount, and its TypeScript language worker
    // (~5.8 MB) the first time a .ts/.tsx file is opened. Neither touches the
    // landing page, whose initial bundle is ~111 KB gzipped. The limit is set
    // above them so the warning still fires on an unintended regression.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the editor core in its own chunk so a change anywhere else in
          // the app does not invalidate it in the browser cache.
          if (id.includes('node_modules/monaco-editor')) return 'monaco';
          if (id.includes('node_modules/@xterm')) return 'xterm';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    // lucide-react ships hundreds of tiny modules; pre-bundling them is slower
    // than letting the dev server serve them directly.
    exclude: ['lucide-react'],
  },
});
