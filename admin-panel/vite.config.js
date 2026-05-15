import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Output directory (default is 'dist')
    outDir: 'dist',
    // Raise warning threshold to avoid noise for normal chunk sizes
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Split vendor dependencies into a separate chunk for better caching
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
})
