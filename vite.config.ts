import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base, so the build works unchanged at a domain root (Vercel), from
  // a subpath, or straight off a plain file server.
  base: './',
  server: {
    host: true,
    // getUserMedia needs a secure context. localhost counts as secure, so plain
    // http is fine locally; use `--host` + a tunnel (or `vite --https`) to test
    // from a phone.
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
})
