import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ekdantaApi } from './server/api.ts'

export default defineConfig({
  plugins: [react(), ekdantaApi()],
  // Local only. To reach it from another device, put it behind `tailscale serve`;
  // tailnet hostnames are allowed so that works without opening the port.
  server: { host: '127.0.0.1', port: 5317, strictPort: true, allowedHosts: ['.ts.net'] },
})
