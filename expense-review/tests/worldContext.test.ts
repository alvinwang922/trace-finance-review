import { describe, expect, it } from 'vitest';
import { analyzeDataset } from '../src/lib/engine';
import { demoDataset } from '../src/data/demo';
import { worldDemoDataset } from '../src/data/worldDemo';
import { extractQuote, findWorldContext, mentionedDates, runWorldResearch, scoreSources, type ResearchTransport, type SearchHit } from '../src/lib/worldContext';
import type { Dataset } from '../src/lib/types';

function contextFor(dataset: Dataset) {
  return findWorldContext(dataset, analyzeDataset(dataset));
}

const visaNotice = `# Duplicate Visa Charges on InvoiceCloud Payments
APR172025
WG+E/WCF is aware of an issue where some customers who made payments over the weekend had their payment withdrawn twice.
**“**InvoiceCloud has received communication from Chase Paymentech that Visa has confirmed that they experienced an issue on their end over the weekend. This issue resulted in issuers duplicating charges to their cardholders. The problem began on Friday and affected settlements until 9 AM ET on Sunday, at which point Visa reverted the change on their end.`;

describe('world context grouping', () => {
  it('groups duplicate postings across employees on the same weekend and network', () => {
    const { clusters, isolated } = contextFor(worldDemoDataset);
    const duplicate = clusters.find((cluster) => cluster.signature === 'duplicate_settlement');
    expect(duplicate?.cases.map((item) => item.groupId)).toEqual(['W01', 'W02', 'W03', 'W04']);
    expect(duplicate?.employees).toHaveLength(4);
    expect(duplicate?.network).toBe('Visa');
    expect(duplicate?.processor).toBe('InvoiceCloud');
    expect(duplicate?.totalCents).toBe(18420 + 41275 + 26800 + 9500);
    expect(isolated.map((item) => item.groupId)).toEqual(['W08']);
  });

  it('groups tip gaps by processor across the month, but never a single person', () => {
    const { clusters } = contextFor(worldDemoDataset);
    const tips = clusters.find((cluster) => cluster.signature === 'tip_after_authorization');
    expect(tips?.cases.map((item) => item.groupId)).toEqual(['W05', 'W06', 'W07']);
    expect(tips?.totalCents).toBe(1720 + 981 + 2376);

    const onePerson = worldDemoDataset.records.filter((record) => ['W05', 'W06'].includes(record.groupId))
      .map((record) => ({ ...record, employee: 'Maya Chen' }));
    expect(contextFor({ ...worldDemoDataset, records: onePerson }).clusters).toHaveLength(0);
  });

  it('finds no shared outside factor in the September demo', () => {
    const { clusters, isolated } = contextFor(demoDataset);
    expect(clusters).toHaveLength(0);
    expect(isolated.length).toBeGreaterThan(0);
  });

  it('builds searches from network, processor and dates only, never people', () => {
    const { clusters } = contextFor(worldDemoDataset);
    const queries = clusters.flatMap((cluster) => cluster.hypothesis.queries).join(' ');
    for (const name of ['Maya', 'Sam', 'Alex', 'Jordan', 'Northgate', 'Fogline']) expect(queries).not.toContain(name);
  });
});

describe('evidence scoring', () => {
  const [duplicate] = contextFor(worldDemoDataset).clusters;

  it('reads dates written several ways', () => {
    expect(mentionedDates('between April 11–13, 2025')).toHaveLength(1);
    expect(mentionedDates('17 abr. 2025 — This issue')).toHaveLength(1);
    expect(mentionedDates('APR172025')).toHaveLength(1);
  });

  it('needs the event, the network and the window together', () => {
    const hits: SearchHit[] = [
      { query: 'q', url: 'https://www.wgeld.org/news/new-news-1/', title: 'Duplicate Visa Charges on InvoiceCloud Payments', snippet: 'Apr 17, 2025 — This issue resulted in issuers duplicating charges to their cardholders. The problem began on Friday.' },
      { query: 'q', url: 'https://example.com/old', title: 'Bank customers double charged for Visa transactions', snippet: '19 Apr 2016 — Some Visa transactions were processed again.' },
      { query: 'q', url: 'https://example.com/generic', title: 'Why was I charged twice?', snippet: 'Duplicate charges often result from pending holds.' },
    ];
    const [best, ...rest] = scoreSources(duplicate, hits);
    expect(best.url).toContain('wgeld.org');
    expect(best.strong).toBe(true);
    expect(rest.every((source) => !source.strong)).toBe(true);
  });

  it('quotes the sentence that names the network and the timing', () => {
    const quote = extractQuote(duplicate, visaNotice);
    expect(quote).toContain('Visa has confirmed');
    expect(quote).toContain('duplicating charges');
    expect(quote).toContain('9 AM ET on Sunday');
  });
});

describe('research run', () => {
  const [duplicate] = contextFor(worldDemoDataset).clusters;

  it('rules an outside event and drafts disputes without contacting anyone', async () => {
    const transport: ResearchTransport = {
      search: async () => [{ query: 'q', url: 'https://www.wgeld.org/news/new-news-1/', title: 'Duplicate Visa Charges on InvoiceCloud Payments', snippet: 'Apr 17, 2025 — issuers duplicating charges over the weekend.' }],
      scrape: async (urls) => urls.map((url) => ({ url, text: visaNotice })),
    };
    const run = await runWorldResearch(duplicate, transport);
    expect(run.ruling.verdict).toBe('outside_event');
    expect(run.ruling.sourceUrl).toContain('wgeld.org');
    expect(run.ruling.actions.filter((action) => action.startsWith('Draft dispute'))).toHaveLength(4);
    expect(run.steps.map((step) => step.kind)).toEqual(['plan', 'search', 'score', 'read', 'rule']);
  });

  it('keeps the cases with a reviewer when the web has nothing', async () => {
    const run = await runWorldResearch(duplicate, { search: async () => [], scrape: async () => [] });
    expect(run.ruling.verdict).toBe('no_outside_cause');
  });

  it('reports a failed search instead of inventing a cause', async () => {
    const run = await runWorldResearch(duplicate, { search: async () => { throw new Error('offline'); }, scrape: async () => [] });
    expect(run.steps.some((step) => step.kind === 'error')).toBe(true);
    expect(run.ruling.verdict).toBe('no_outside_cause');
  });
});
