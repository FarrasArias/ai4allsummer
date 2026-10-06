import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The app calls the API on its own origin; in dev, forward it to the
    // backend's local listener.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
