import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The API lives on its own port. Proxying keeps the browser on one origin, so the
// httpOnly session cookie is first-party and no CORS preflights are needed in development.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ''); // '.' = the frontend folder (where npm runs Vite)
  const api = env.API_URL || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.PORT) || 5173,
      // Public tunnels: cloudflared quick tunnels (random *.trycloudflare.com).
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
        '/api': { target: api, xfwd: true },
        '/admin': { target: api, xfwd: true },
      },
    },
  };
});
