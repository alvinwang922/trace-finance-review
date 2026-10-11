import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleResearch, type ResearchRequest } from './base44/functions/worldResearch/brightdata.ts';

/**
 * Development-only proxy for World context research. Reads BRIGHTDATA_API_KEY from
 * .env.local on the dev server, so the key never reaches the browser bundle. The hosted
 * app uses the Base44 `worldResearch` function instead.
 */
function worldResearchDevProxy(token: string | undefined): Plugin {
  return {
    name: 'world-research-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/world-research', async (incoming, res) => {
        // The project has no Node type package; describe only what this handler uses.
        const req = incoming as unknown as { method?: string } & AsyncIterable<string | Uint8Array>;
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { error: 'POST only.' });
        if (!token) return send(503, { error: 'Add BRIGHTDATA_API_KEY to .env.local to run live research locally.' });
        let raw = '';
        for await (const chunk of req) raw += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        try {
          send(200, await handleResearch(token, JSON.parse(raw) as ResearchRequest));
        } catch (error) {
          send(502, { error: error instanceof Error ? error.message : 'Research failed.' });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return { plugins: [react(), worldResearchDevProxy(env.BRIGHTDATA_API_KEY)] };
});
