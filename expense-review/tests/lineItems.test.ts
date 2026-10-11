import { describe, expect, it } from 'vitest';
import { demoDataset } from '../src/data/demo';
import { compareLineItems, parseLineItems, swappedDigits } from '../src/lib/lineItems';
import type { RecordSource, SourceRecord } from '../src/lib/types';

const group = (id: string) => demoDataset.records.filter((record) => record.groupId === id) as SourceRecord[];

function record(id: string, source: RecordSource, amountCents: number, description: string): SourceRecord {
  return { id, groupId: 'g', date: '2025-04-03', merchant: 'Fogline Kitchen', employee: 'Maya Chen', source, amountCents, currency: 'USD', description, fileName: `${id}.txt` };
}

describe('line item parsing', () => {
  it('reads labels before or after an amount, but not across punctuation', () => {
    expect(parseLineItems({ description: 'Team dinner submitted as $100.00 meal plus $21.40 tip.', amountCents: 12140 }).values)
      .toEqual({ base: 10000, tip: 2140 });
    expect(parseLineItems({ description: 'Meal $100.00; gratuity $12.00; total $112.00.', amountCents: 11200 }).values)
      .toEqual({ base: 10000, tip: 1200, total: 11200 });
  });

  it('ignores unlabeled amounts unless they equal the record amount', () => {
    expect(parseLineItems({ description: 'Net expense after $300.00 in shipments less a $40.00 posted refund.', amountCents: 26000 }).values).toEqual({});
    expect(parseLineItems({ description: 'Workshop materials submitted at $286.50.', amountCents: 28650 }).values).toEqual({ total: 28650 });
  });

  it('detects swapped digits exactly', () => {
    expect(swappedDigits(28650, 26850)).toEqual(['8', '6']);
    expect(swappedDigits(11400, 11200)).toBeNull();
  });
});

describe('line item comparison', () => {
  it('puts the whole Juniper Table gap in the tip line', () => {
    const result = compareLineItems(group('G01'));
    expect(result?.cause).toBe('tip');
    expect(result?.rows.find((row) => row.category === 'base')?.status).toBe('match');
    expect(result?.rows.find((row) => row.category === 'tip')).toMatchObject({ claimedCents: 2140, receiptCents: 1200, status: 'differs' });
    expect(result?.explanation).toContain('The whole $9.40 difference is in the tip line');
    expect(result?.question).toContain('$12.00 tip');
  });

  it('names the swapped digits on Lumen Workshop', () => {
    const result = compareLineItems(group('G03'));
    expect(result?.cause).toBe('swapped_digits');
    expect(result?.question).toBe('Could $268.50 have been entered as $286.50?');
  });

  it('shows matching lines without inventing a cause', () => {
    const result = compareLineItems(group('G08'));
    expect(result?.cause).toBeNull();
    expect(result?.rows.every((row) => row.status === 'match')).toBe(true);
  });

  it('explains a card charge above a receipt with a blank tip line', () => {
    const result = compareLineItems([
      record('e', 'expense', 8600, 'Client lunch entered from the receipt photo: $86.00.'),
      record('r', 'receipt', 8600, 'Itemized receipt photo: food $79.00, tax $7.00, total $86.00. Tip line blank.'),
      record('c', 'card', 10320, 'Mastercard posting, settled amount.'),
    ]);
    expect(result?.cause).toBe('tip_after_receipt');
    expect(result?.explanation).toContain('$17.20 (20%) higher');
  });

  it('stays silent when there is nothing to compare', () => {
    expect(compareLineItems(group('G04'))).toBeNull();
    expect(compareLineItems(group('G02'))).toBeNull();
  });
});
