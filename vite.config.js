import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * API keys are read from .env (NOT VITE_-prefixed) and injected server-side by
 * these proxies, so they never reach the browser bundle.
 *
 *   /api/greptile/*  -> https://api.greptile.com/*        (+ Authorization, X-GitHub-Token)
 *   /api/skybox/*    -> https://backend.blockadelabs.com/*(+ x-api-key)
 *   /api/github/*    -> https://api.github.com/*          (+ Authorization if token set)
 *
 * Frontend code must call these paths, never the upstream hosts directly.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const greptileKey = env.GREPTILE_API_KEY || '';
  const githubToken = env.GITHUB_TOKEN || '';
  const blockadeKey = env.BLOCKADE_API_KEY || '';

  const setHeaders = (headers) => (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      for (const [k, v] of Object.entries(headers)) {
        if (v) proxyReq.setHeader(k, v);
      }
    });
  };

  const proxy = {
    '/api/greptile': {
      target: 'https://api.greptile.com',
      changeOrigin: true,
      secure: true,
      rewrite: (p) => p.replace(/^\/api\/greptile/, ''),
      configure: setHeaders({
        Authorization: greptileKey ? `Bearer ${greptileKey}` : '',
        'X-GitHub-Token': githubToken,
      }),
    },
    '/api/skybox': {
      target: 'https://backend.blockadelabs.com',
      changeOrigin: true,
      secure: true,
      rewrite: (p) => p.replace(/^\/api\/skybox/, ''),
      configure: setHeaders({ 'x-api-key': blockadeKey }),
    },
    '/api/github': {
      target: 'https://api.github.com',
      changeOrigin: true,
      secure: true,
      rewrite: (p) => p.replace(/^\/api\/github/, ''),
      configure: setHeaders({
        Authorization: githubToken ? `Bearer ${githubToken}` : '',
        'User-Agent': 'repo-world',
      }),
    },
  };

  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    define: {
      // Booleans only — never the key values themselves.
      __HAS_GREPTILE__: JSON.stringify(Boolean(greptileKey)),
      __HAS_BLOCKADE__: JSON.stringify(Boolean(blockadeKey)),
      __HAS_GITHUB_TOKEN__: JSON.stringify(Boolean(githubToken)),
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.js'],
    },
  };
});
