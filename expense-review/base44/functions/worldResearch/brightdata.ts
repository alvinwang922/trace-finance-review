/**
 * Server-only Bright Data client, shared by the Base44 function, the Vite dev server and
 * the recording script. It talks to Bright Data's hosted MCP server, which needs only an
 * API token (no zones to set up). Never import this from browser code: the token must
 * stay on the server.
 */

const MCP_URL = 'https://mcp.brightdata.com/mcp';
const MAX_QUERIES = 10;
const MAX_URLS = 3;
const MAX_PAGE_CHARS = 30_000;

export interface SearchHit { query: string; url: string; title: string; snippet: string }
export interface ScrapedPage { url: string; text: string }

/** Bright Data wraps fetched web content in markers; return only the content between them. */
export function unwrapUntrusted(text: string): string {
  const match = text.match(/=====UNTRUSTED_(\w+)_BEGIN=====\n([\s\S]*)\n=====UNTRUSTED_\1_END=====/);
  return match ? match[2] : text;
}

async function callTool(token: string, tool: string, args: Record<string, unknown>): Promise<string> {
  const url = `${MCP_URL}?token=${encodeURIComponent(token)}`;
  let session: string | null = null;
  let id = 1;
  const send = async (method: string, params: unknown, notify = false) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: id++, method, params };
    // A stalled request must not hang the review; callers fall back to the recorded run.
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    session = response.headers.get('mcp-session-id') || session;
    if (!response.ok) throw new Error(`Bright Data returned HTTP ${response.status}`);
    if (notify) return null;
    const raw = await response.text();
    const data = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    const payload = JSON.parse(data.length ? data[data.length - 1] : raw);
    if (payload.error) throw new Error(`Bright Data error: ${payload.error.message || 'request failed'}`);
    return payload.result;
  };
  await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'trace-world-context', version: '0.1.0' } });
  await send('notifications/initialized', {}, true);
  const result = await send('tools/call', { name: tool, arguments: args }) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
  if (result?.isError) throw new Error(`Bright Data ${tool} failed`);
  return unwrapUntrusted(text);
}

export async function searchMany(token: string, queries: string[]): Promise<SearchHit[]> {
  const clean = queries.map((query) => String(query).trim().slice(0, 200)).filter(Boolean).slice(0, MAX_QUERIES);
  if (!clean.length) return [];
  const text = await callTool(token, 'search_engine_batch', { queries: clean.map((query) => ({ query, engine: 'google' })) });
  const batches = JSON.parse(text) as { query: string; result?: { organic?: { link?: string; title?: string; description?: string }[] } }[];
  return batches.flatMap((batch) => (batch.result?.organic ?? []).slice(0, 8).map((item) => ({
    query: batch.query,
    url: String(item.link ?? ''),
    title: String(item.title ?? ''),
    snippet: String(item.description ?? '').replace(/Read more$/, '').trim(),
  }))).filter((hit) => /^https:\/\//.test(hit.url));
}

export async function scrapeMany(token: string, urls: string[]): Promise<ScrapedPage[]> {
  const clean = urls.filter((url) => /^https:\/\/[^\s]+$/.test(String(url))).slice(0, MAX_URLS);
  if (!clean.length) return [];
  const text = await callTool(token, 'scrape_batch', { urls: clean });
  const pages = JSON.parse(text) as { url?: string; content?: string }[];
  return pages.map((page) => ({ url: String(page.url ?? ''), text: String(page.content ?? '').slice(0, MAX_PAGE_CHARS) }));
}

export type ResearchRequest = { action: 'search'; queries: string[] } | { action: 'scrape'; urls: string[] };

export async function handleResearch(token: string, request: ResearchRequest): Promise<{ hits?: SearchHit[]; pages?: ScrapedPage[] }> {
  if (request.action === 'search' && Array.isArray(request.queries)) return { hits: await searchMany(token, request.queries) };
  if (request.action === 'scrape' && Array.isArray(request.urls)) return { pages: await scrapeMany(token, request.urls) };
  throw new Error('Unsupported research request');
}
