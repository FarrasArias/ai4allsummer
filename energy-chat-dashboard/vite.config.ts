import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The app calls the API on its own origin; in dev, forward it to the
    // backend's local listener (UNESS_API_PROXY points it elsewhere, e.g. a
    // second backend for testing).
    // Keep the browser's Host header (the shorthand form rewrites it), so links
    // the backend builds — invite and reset links — point at this dev server.
    proxy: {
      '/api': {
        target: process.env.UNESS_API_PROXY ?? 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
    },
  },
})
