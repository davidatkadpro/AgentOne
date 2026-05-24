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
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-dom') || id.includes('scheduler') || /node_modules[\\/]react[\\/]/.test(id)) {
            return 'vendor-react'
          }
          if (id.includes('@tanstack')) return 'vendor-tanstack'
          if (id.includes('react-router')) return 'vendor-router'
          if (id.includes('lucide-react')) return 'vendor-icons'
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('rehype-') ||
            id.includes('highlight.js') ||
            id.includes('mdast-') ||
            id.includes('hast-') ||
            id.includes('micromark') ||
            id.includes('unified') ||
            id.includes('unist-') ||
            id.includes('vfile') ||
            id.includes('bail') ||
            id.includes('trough') ||
            id.includes('property-information') ||
            id.includes('space-separated-tokens') ||
            id.includes('comma-separated-tokens') ||
            id.includes('character-entities') ||
            id.includes('decode-named-character-reference') ||
            id.includes('html-url-attributes') ||
            id.includes('zwitch') ||
            id.includes('longest-streak') ||
            id.includes('ccount') ||
            id.includes('escape-string-regexp') ||
            id.includes('markdown-table') ||
            id.includes('devlop') ||
            id.includes('estree-')
          ) {
            return 'vendor-markdown'
          }
          if (id.includes('dompurify')) return 'vendor-dompurify'
          if (id.includes('react-hook-form') || id.includes('@hookform') || id.includes('/zod/')) {
            return 'vendor-forms'
          }
          if (id.includes('sonner')) return 'vendor-toast'
          if (id.includes('zustand')) return 'vendor-state'
          return undefined
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
