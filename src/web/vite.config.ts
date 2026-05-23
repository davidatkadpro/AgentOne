import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3737',
      '/ws': { target: 'ws://localhost:3737', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
