/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  // Phase 6 backend (docker compose up -d); the editor works without it
  server: { proxy: { '/api': 'http://127.0.0.1:8001' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8001' } },
  test: { environment: 'node' },
})
