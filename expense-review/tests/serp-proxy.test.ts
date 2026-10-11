import { describe, expect, it, vi } from 'vitest';
import { createLookup, normalize, parsePayload, serpPlugin } from '../server/serp';

const env = { BRIGHTDATA_API_TOKEN: 'test-secret', BRIGHTDATA_SERP_DATASET: 'dataset' };
const organic = { organic: [{ title: 'Coffee', link: 'https://coffee.example', description: 'Menu $3–$7' }] };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Bright Data proxy', () => {
  it('sends both required SERP inputs and requests a JSON response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply([organic]));
    const result = await createLookup(env, fetcher).search('Coffee shop');
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain('format=json');
    expect(JSON.parse(String(init?.body))).toEqual([{ url: 'https://www.google.com/', keyword: 'Coffee shop', language: 'en', start_page: 1, end_page: 1 }]);
    expect(result.organic[0].snippet).toBe('Menu $3–$7');
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('polls asynchronous jobs and downloads their completed results', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ snapshot_id: 'snapshot' }, 202))
      .mockResolvedValueOnce(reply({ status: 'running' }))
      .mockResolvedValueOnce(reply({ status: 'ready' }))
      .mockResolvedValueOnce(reply([organic]));
    const pause = vi.fn().mockResolvedValue(undefined);
    const result = await createLookup(env, fetcher, pause).search('Coffee');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/trigger?'), expect.stringContaining('/progress/snapshot'),
      expect.stringContaining('/progress/snapshot'), expect.stringContaining('/snapshot/snapshot?format=json'),
    ]);
    expect(result.organic).toHaveLength(1);
  });

  it('surfaces failed jobs, rejected credentials, malformed output and per-record errors', async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(reply({ error: 'secret details' }, 401));
    await expect(createLookup(env, rejected).search('Coffee')).rejects.toMatchObject({ code: 'upstream_error', upstreamStatus: 401 });
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ snapshot_id: 's' }, 202)).mockResolvedValueOnce(reply({ status: 'failed' }));
    await expect(createLookup(env, failed, async () => {}).search('Coffee')).rejects.toMatchObject({ code: 'scrape_failed' });
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Blocked</html>'));
    await expect(createLookup(env, html).search('Coffee')).rejects.toMatchObject({ code: 'invalid_response' });
    const errors = vi.fn<typeof fetch>().mockResolvedValue(reply([{ error: 'failed' }]));
    await expect(createLookup(env, errors).search('Coffee')).rejects.toMatchObject({ code: 'scrape_failed' });
  });

  it('does not label an empty response as live results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({}));
    await expect(createLookup(env, fetcher).search('Coffee')).rejects.toMatchObject({ code: 'no_results' });
  });

  it('returns only a small set of results to the browser', () => {
    const result = normalize({ organic: Array.from({ length: 100 }, () => organic.organic[0]), aio_text: 'x'.repeat(10000) });
    expect(result.organic).toHaveLength(4);
    expect(result.aioText).toHaveLength(2000);
  });

  it('parses NDJSON and all result records, including snack_pack local places', () => {
    const result = normalize(parsePayload(`${JSON.stringify(organic)}\n${JSON.stringify({ snack_pack: [{ title: 'Cafe', address: '1 Main St', rating: '4.5' }] })}\n`));
    expect(result.organic).toHaveLength(1);
    expect(result.local[0]).toMatchObject({ title: 'Cafe', address: '1 Main St', rating: 4.5 });
  });

  it('uses local SERP search rather than giving a search URL to the place scraper', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply([{ snack_pack: [{ title: 'Cafe', address: '1 Main' }] }]));
    const result = await createLookup({ ...env, BRIGHTDATA_MAPS_DATASET: 'places-only' }, fetcher).search('Cafe location', 'maps');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))[0]).toMatchObject({ keyword: 'Cafe location' });
    expect(result.local[0].address).toBe('1 Main');
  });

  it('supports a SERP zone when no dataset is configured', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(organic));
    await createLookup({ BRIGHTDATA_API_TOKEN: 'test', BRIGHTDATA_SERP_ZONE: 'my-zone' }, fetcher).search('Coffee & tea', 'maps');
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.zone).toBe('my-zone');
    expect(new URL(body.url).searchParams.get('q')).toBe('Coffee & tea');
    expect(new URL(body.url).searchParams.get('tbm')).toBe('lcl');
  });

  it('deduplicates concurrent searches and caches successful results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply([organic]));
    const lookup = createLookup(env, fetcher);
    await Promise.all([lookup.search('Coffee'), lookup.search('Coffee')]);
    await lookup.search('Coffee');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed searches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({}, 500)).mockResolvedValueOnce(reply([organic]));
    const lookup = createLookup(env, fetcher);
    await expect(lookup.search('Coffee')).rejects.toThrow();
    expect((await lookup.search('Coffee')).organic).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not treat Maps-only configuration as a connected search backend', () => {
    expect(createLookup({ BRIGHTDATA_API_TOKEN: 'test', BRIGHTDATA_MAPS_DATASET: 'places-only' }).configured).toBe(false);
  });

  it('installs the proxy for development and build preview', () => {
    const plugin = serpPlugin(env);
    const use = vi.fn();
    (plugin.configureServer as Function)({ middlewares: { use } });
    (plugin.configurePreviewServer as Function)({ middlewares: { use } });
    expect(use).toHaveBeenCalledTimes(2);
  });
});
