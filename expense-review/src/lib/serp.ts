// Bright Data SERP lookups for public merchant context.
// Talks only to the server proxy (/api/serp) — the API token never reaches the browser.
// Returns a user-facing failure reason alongside any live result.

export type SerpHit = { title: string; link: string; snippet: string };
export type SerpPlace = { title: string; address: string; rating: number | null; type: string };
export type SerpResult = { organic: SerpHit[]; local: SerpPlace[]; knowledge: { title: string; description: string; address: string } | null; aioText?: string };
export type WebCandidate = { name: string; website: string; location: string; category: string; confidence: number; signals: string[] };
export type PriceRange = { lowCents: number; highCents: number };
export type LivePrice = { priceRange: string; priceSignal: string; priceNote: string };

const fmt = (cents: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD' }).format(cents / 100);

export async function serpAvailable(): Promise<boolean> {
  try { const res = await fetch('/api/serp/status', { signal: AbortSignal.timeout(5000) }); return res.ok && (await res.json()).configured === true; } catch { return false; }
}

export type SearchOutcome = { result: SerpResult | null; error: string | null };
export async function serpLookup(query: string, type: 'search' | 'maps' = 'search', signal?: AbortSignal): Promise<SearchOutcome> {
  try {
    const timeout = AbortSignal.timeout(605_000);
    const res = await fetch('/api/serp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: query, type }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const data = await res.json();
    if (!res.ok) {
      const message = data.error === 'timeout' ? 'The public lookup timed out.'
        : data.error === 'no_results' ? 'No public results were found.'
        : data.error === 'not_configured' ? 'Public lookups are not connected.'
        : data.upstreamStatus === 401 || data.upstreamStatus === 403 ? 'Bright Data rejected the configured credentials.'
        : 'The public lookup is temporarily unavailable.';
      return { result: null, error: message };
    }
    if (!Array.isArray(data.organic) || !Array.isArray(data.local)) throw new Error('Invalid search response');
    return { result: data, error: null };
  } catch { return { result: null, error: 'The public lookup could not be reached.' }; }
}

export async function serpSearch(query: string, type: 'search' | 'maps' = 'search'): Promise<SerpResult | null> {
  return (await serpLookup(query, type)).result;
}

const cleanName = (title: string) => title.replace(/\s+[–—|]\s+.*$/, '').replace(/\s+-\s+(Wikipedia|Google|Yelp|Facebook|Instagram|LinkedIn|Tripadvisor).*$/i, '').trim();
const domain = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Turn a card-statement descriptor (e.g. "STRBKS #10432 NEW YORK") plus SERP
// results into reviewer-confirmable merchant candidates.
export function candidatesFromSerp(hits: SerpHit[], descriptor: string): WebCandidate[] {
  return hits.slice(0, 4).map((hit, index) => ({
    name: cleanName(hit.title) || 'Unknown business',
    website: domain(hit.link) || 'public web result',
    location: 'Public web result — confirm before saving',
    category: index === 0 ? 'Top public match' : 'Public web result',
    confidence: Math.max(30, 82 - index * 14),
    signals: [
      hit.snippet ? hit.snippet.slice(0, 120) : 'Public search result',
      `Matched against card descriptor "${descriptor}"`,
      'Not verified — a reviewer must confirm the match',
    ],
  }));
}

export function extractPriceCents(text: string): number[] {
  const prices: number[] = [];
  for (const match of text.matchAll(/\$(\d{1,4}(?:\.\d{1,2})?)/g)) {
    const cents = Math.round(parseFloat(match[1]) * 100);
    if (cents >= 50 && cents <= 50000) prices.push(cents);
  }
  return prices;
}

// Typical public price range for a merchant's menu/catalog, trimmed to the
// middle 70% of mentioned prices so outliers don't dominate.
export function menuPriceRange(hits: SerpHit[], aioText = ''): PriceRange | null {
  const prices = [...hits.map(hit => `${hit.title} ${hit.snippet}`), aioText]
    .flatMap(extractPriceCents).sort((a, b) => a - b);
  if (prices.length < 2) return null;
  const lo = prices[Math.floor(prices.length * 0.15)];
  const hi = prices[Math.min(prices.length - 1, Math.max(0, Math.ceil(prices.length * 0.85) - 1))];
  return lo < hi ? { lowCents: lo, highCents: hi } : null;
}

// Compare the actual card charge against the public range — flags possible
// overspending without calling it confirmed loss.
export function livePrice(range: PriceRange, chargeCents: number, currency: string): LivePrice {
  const charge = Math.abs(chargeCents);
  const rangeText = `${fmt(range.lowCents, currency)}–${fmt(range.highCents, currency)}`;
  if (charge > range.highCents) return { priceRange: rangeText, priceSignal: 'Above typical public prices', priceNote: `This ${fmt(charge, currency)} charge is above the typical public range of ${rangeText}. Could be a larger order, fees, or overspending — check the receipt line items.` };
  if (charge < range.lowCents) return { priceRange: rangeText, priceSignal: 'Below typical public prices', priceNote: `This ${fmt(charge, currency)} charge is below the typical public range of ${rangeText} — possibly a partial order or a different location.` };
  return { priceRange: rangeText, priceSignal: 'Within typical public prices', priceNote: `This ${fmt(charge, currency)} charge sits inside the typical public range of ${rangeText}.` };
}

// Approximate merchant location from public map results, to compare with the
// address shown on the receipt.
export function placeFromSerp(result: SerpResult | null): string | null {
  const place = result?.local?.[0];
  if (place) return `${place.title}${place.address ? ` · ${place.address}` : ''}`;
  return result?.knowledge?.address || null;
}
