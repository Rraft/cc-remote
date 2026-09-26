import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 局域网调试时手机可直接访问 dev server
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
