import type { ResearchTransport, ScrapedPage, SearchHit } from './worldContext';
import { invokeWorldResearch, isBase44Configured } from './base44';

type Payload = { action: 'search'; queries: string[] } | { action: 'scrape'; urls: string[] };
type Result = { hits?: SearchHit[]; pages?: ScrapedPage[]; error?: string };

/** Local development uses the Vite proxy (key in .env.local); the hosted app uses the Base44 function. */
async function call(payload: Payload): Promise<Result> {
  if (import.meta.env.DEV) {
    const response = await fetch('/api/world-research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json().catch(() => ({})) as Result;
    if (!response.ok) throw new Error(data.error || 'Public-web research failed.');
    return data;
  }
  return invokeWorldResearch<Result>(payload);
}

export const liveResearchAvailable = import.meta.env.DEV || isBase44Configured;

export const researchTransport: ResearchTransport = {
  async search(queries) { return (await call({ action: 'search', queries })).hits ?? []; },
  async scrape(urls) { return (await call({ action: 'scrape', urls })).pages ?? []; },
};
