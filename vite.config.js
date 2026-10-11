import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * MechaSim build configuration.
 *
 * `allowedHosts: true` is required because the app is served through the Arena
 * sandbox preview proxy (Host: <port>-<sandbox>.e2b.app) as well as through any
 * user-supplied reverse proxy. Vite's dev-time host check would otherwise 403.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    fs: { strict: false },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    reporters: 'default',
  },
})
