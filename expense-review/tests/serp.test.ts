import { describe, expect, it } from 'vitest';
import { candidatesFromSerp, extractPriceCents, livePrice, menuPriceRange, placeFromSerp } from '../src/lib/serp';

describe('extractPriceCents', () => {
  it('extracts dollar amounts as cents', () => {
    expect(extractPriceCents('Latte $4.95, pastry $3, sandwich $12.50')).toEqual([495, 300, 1250]);
  });
  it('ignores implausible prices', () => {
    expect(extractPriceCents('Save $0.10 or earn $99999')).toEqual([]);
  });
});

describe('menuPriceRange', () => {
  it('builds a range from organic snippet prices', () => {
    const hits = [
      { title: 'Menu', link: 'https://m.example', snippet: 'Coffee $3.50 · Latte $4.95' },
      { title: 'Prices', link: 'https://p.example', snippet: 'Sandwich $9.25 · Salad $8.00' },
    ];
    const range = menuPriceRange(hits)!;
    expect(range.lowCents).toBeLessThan(range.highCents);
    expect(range.lowCents).toBeGreaterThanOrEqual(300);
    expect(range.highCents).toBeLessThanOrEqual(1000);
  });
  it('returns null with fewer than two prices', () => {
    expect(menuPriceRange([{ title: 'x', link: '', snippet: 'only $5.00' }])).toBeNull();
  });
  it('uses the AI-overview text as an extra price source', () => {
    const range = menuPriceRange([], 'Typical items run $8 to $15 per person');
    expect(range).not.toBeNull();
    expect(range!.lowCents).toBeGreaterThanOrEqual(800);
    expect(range!.highCents).toBeLessThanOrEqual(1500);
  });
});

describe('livePrice', () => {
  const range = { lowCents: 300, highCents: 900 };
  it('flags a charge above the public range', () => {
    expect(livePrice(range, 1500, 'USD').priceSignal).toBe('Above typical public prices');
  });
  it('accepts a charge inside the range', () => {
    expect(livePrice(range, 600, 'USD').priceSignal).toBe('Within typical public prices');
  });
  it('notes a charge below the range', () => {
    expect(livePrice(range, 200, 'USD').priceSignal).toBe('Below typical public prices');
  });
});

describe('candidatesFromSerp', () => {
  it('turns search hits into confirmable candidates', () => {
    const hits = [{ title: 'Starbucks - Wikipedia', link: 'https://en.wikipedia.org/wiki/Starbucks', snippet: 'Coffee chain' }];
    const [c] = candidatesFromSerp(hits, 'STRBKS');
    expect(c.name).toBe('Starbucks');
    expect(c.website).toBe('en.wikipedia.org');
    expect(c.signals.join(' ')).toContain('STRBKS');
  });
});

describe('placeFromSerp', () => {
  it('prefers the first local result', () => {
    expect(placeFromSerp({ organic: [], knowledge: null, local: [{ title: 'Starbucks', address: '1 Main St', rating: 4.1, type: 'Cafe' }] })).toBe('Starbucks · 1 Main St');
  });
  it('falls back to knowledge address then null', () => {
    expect(placeFromSerp({ organic: [], local: [], knowledge: { title: '', description: '', address: '2 Elm St' } })).toBe('2 Elm St');
    expect(placeFromSerp(null)).toBeNull();
  });
});
