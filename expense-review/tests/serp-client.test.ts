import { afterEach, describe, expect, it, vi } from 'vitest';
import { serpAvailable, serpLookup } from '../src/lib/serp';

afterEach(() => vi.unstubAllGlobals());

describe('public lookup client', () => {
  it('returns normalized live results from the server', async () => {
    const result = { organic: [{ title: 'Cafe', link: 'https://example.com', snippet: 'Menu' }], local: [], knowledge: null };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal('fetch', fetcher);
    expect(await serpLookup('Cafe')).toEqual({ result, error: null });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ q: 'Cafe', type: 'search' });
  });

  it.each([
    [{ error: 'timeout' }, 504, 'timed out'],
    [{ error: 'no_results' }, 404, 'No public results'],
    [{ error: 'upstream_error', upstreamStatus: 401 }, 502, 'credentials'],
  ])('reports a useful failure message for %j', async (body, status, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
    const outcome = await serpLookup('Cafe');
    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain(message);
  });

  it('does not mistake a static host HTML fallback for API availability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Trace</html>')));
    expect(await serpAvailable()).toBe(false);
    expect((await serpLookup('Cafe')).result).toBeNull();
  });

  it('does not accept malformed JSON as a successful lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"failed"}')));
    expect(await serpLookup('Cafe')).toMatchObject({ result: null, error: expect.any(String) });
  });
});
