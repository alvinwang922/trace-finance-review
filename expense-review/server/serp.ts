import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { SerpResult } from '../src/lib/serp';

const API = 'https://api.brightdata.com';
type Row = Record<string, any>;
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];

// /scrape defaults to NDJSON; snapshots may be JSON arrays.
export function parsePayload(text: string): any {
  try { return JSON.parse(text); }
  catch { return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
}

export function normalize(payload: any): SerpResult {
  const records = Array.isArray(payload) ? payload : [payload];
  const result: SerpResult = { organic: [], local: [], knowledge: null, aioText: '' };
  for (const record of records) {
    if (!record || record.error) continue;
    result.organic.push(...rows(record.organic || record.results).map(o => ({
      title: str(o.title), link: str(o.link || o.url), snippet: str(o.description || o.snippet || o.text),
    })).filter(o => o.title));
    const local = record.snack_pack || record.local_pack || record.local_results || record.maps_results || record.places || record.local;
    const places = rows(local?.items || local?.results || local);
    if (record.name && record.address) places.push(record);
    result.local.push(...places.map(p => ({
      title: str(p.title || p.name), address: str(p.address || p.full_address || p.vicinity),
      rating: Number.isFinite(Number(p.rating)) && p.rating != null ? Number(p.rating) : null,
      type: str(p.category || p.type),
    })).filter(p => p.title));
    if (record.knowledge) result.knowledge = {
      title: str(record.knowledge.title), description: str(record.knowledge.description), address: str(record.knowledge.address),
    };
    const overview = record.aio_text || record.ai_overview?.text;
    result.aioText += (typeof overview === 'string' ? overview : rows(overview).map(x => str(x.text)).join(' ')) + ' ';
  }
  return { ...result, organic: result.organic.slice(0, 4), local: result.local.slice(0, 3), aioText: result.aioText?.slice(0, 2000) };
}

export class LookupError extends Error {
  constructor(public code: string, public status = 502, public upstreamStatus?: number) { super(code); }
}

export function createLookup(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch, pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  const token = env.BRIGHTDATA_API_TOKEN;
  const dataset = env.BRIGHTDATA_SERP_DATASET;
  const zone = env.BRIGHTDATA_SERP_ZONE;
  const configured = Boolean(token && (dataset || zone));
  const cache = new Map<string, { expires: number; result: SerpResult }>();
  const pending = new Map<string, Promise<SerpResult>>();
  async function run(query: string, type: 'search' | 'maps') {
    if (!configured) throw new LookupError('not_configured', 503);
    const signal = AbortSignal.timeout(600_000);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    async function request(path: string, body?: unknown) {
      const response = await fetcher(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers, signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new LookupError('upstream_error', 502, response.status);
      try { return parsePayload(await response.text()); }
      catch { throw new LookupError('invalid_response'); }
    }
    try {
      let payload;
      if (dataset) {
        // Local search uses SERP's local section. The Maps full-information
        // scraper requires a specific place URL, not a free-text search URL.
        payload = await request(`/datasets/v3/trigger?dataset_id=${encodeURIComponent(dataset)}&format=json&include_errors=true`, [
          { url: 'https://www.google.com/', keyword: query, language: 'en', start_page: 1, end_page: 1 },
        ]);
        if (payload.snapshot_id) {
          const id = encodeURIComponent(payload.snapshot_id);
          for (;;) {
            signal.throwIfAborted();
            await pause(5000);
            const progress = await request(`/datasets/v3/progress/${id}`);
            if (progress.status === 'failed') throw new LookupError('scrape_failed');
            if (progress.status === 'ready') break;
          }
          payload = await request(`/datasets/v3/snapshot/${id}?format=json`);
        }
      } else {
        const url = new URL('https://www.google.com/search');
        url.search = new URLSearchParams({ q: query, hl: 'en', brd_json: '1', ...(type === 'maps' ? { tbm: 'lcl' } : {}) }).toString();
        payload = await request('/request', { zone, url: url.href, format: 'raw' });
      }
      if (payload?.error || (Array.isArray(payload) && payload.length && payload.every(r => r?.error))) throw new LookupError('scrape_failed');
      const result = normalize(payload);
      if (!result.organic.length && !result.local.length && !result.knowledge && !result.aioText?.trim()) throw new LookupError('no_results', 404);
      return result;
    } catch (error) {
      if (error instanceof LookupError) throw error;
      throw new LookupError(signal.aborted ? 'timeout' : 'network_error', signal.aborted ? 504 : 502);
    }
  }
  return {
    configured, backend: dataset ? 'datasets' : zone ? 'zone' : null,
    async search(query: string, type: 'search' | 'maps' = 'search') {
      const key = `${type}:${query}`;
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return hit.result;
      if (pending.has(key)) return pending.get(key)!;
      const job = run(query, type).then(result => {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: Date.now() + 300_000, result });
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    },
  };
}

export function serpPlugin(env: Record<string, string | undefined>): Plugin {
  const lookup = createLookup(env);
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
  };
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0];
    if (path !== '/api/serp' && path !== '/api/serp/status') return next();
    if (path === '/api/serp/status') return send(res, 200, { configured: lookup.configured, backend: lookup.backend });
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return send(res, 413, { error: 'body_too_large' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'bad_query' }); }
      const { q, type = 'search' } = input || {};
      if (typeof q !== 'string' || !q.trim() || q.length > 300 || !['search', 'maps'].includes(type)) return send(res, 400, { error: 'bad_query' });
      send(res, 200, await lookup.search(q.trim(), type));
    } catch (error) {
      const failure = error instanceof LookupError ? error : new LookupError('lookup_failed', 500);
      send(res, failure.status, { error: failure.code, ...(failure.upstreamStatus ? { upstreamStatus: failure.upstreamStatus } : {}) });
    }
  };
  return {
    name: 'serp-proxy',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
