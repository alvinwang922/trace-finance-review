import { describe, expect, it } from 'vitest';
import { analyzeDataset } from '../src/lib/engine';
import { parseCsvRecords, recordsToCsv } from '../src/lib/csv';
import type { Dataset, RecordSource, SourceRecord } from '../src/lib/types';

function record(id: string, source: RecordSource, amountCents: number, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id, source, amountCents, groupId: 'purchase-1', date: '2026-10-01',
    merchant: 'Sample merchant', employee: 'Alex', currency: 'USD',
    description: '', fileName: `${id}.csv`, ...overrides,
  };
}

function analyze(records: SourceRecord[]) {
  const dataset: Dataset = { id: 'test', name: 'Test', records, isDemo: true };
  return analyzeDataset(dataset);
}

describe('evidence comparisons', () => {
  it('identifies a two-dollar claim difference without inventing a gratuity cause', () => {
    const [result] = analyze([
      record('claim', 'expense', 11400), record('receipt', 'receipt', 11200), record('charge', 'card', 11200),
    ]);
    expect(result.kind).toBe('amount_difference');
    expect(result.actualCents).toBe(11400);
    expect(result.expectedCents).toBe(11200);
    expect(result.differenceCents).toBe(200);
    expect(result.summary).not.toMatch(/gratuity|fraud|overpaid/i);
  });

  it('explains split shipments and a refund without double-counting the order', () => {
    const [result] = analyze([
      record('claim', 'expense', 26000), record('order', 'order', 30000),
      record('r1', 'receipt', 12000, { reference: 'shipment-1' }),
      record('r2', 'receipt', 18000, { reference: 'shipment-2' }),
      record('c1', 'card', 12000, { reference: 'shipment-1' }),
      record('c2', 'card', 18000, { reference: 'shipment-2' }),
      record('refund', 'refund', 4000, { reference: 'refund-1' }),
    ]);
    expect(result.kind).toBe('split_purchase');
    expect(result.actualCents).toBe(26000);
    expect(result.expectedCents).toBe(26000);
    expect(result.differenceCents).toBe(0);
  });

  it('does not match identical merchants or amounts across different group IDs', () => {
    const results = analyze([
      record('claim', 'expense', 10000, { groupId: 'one' }),
      record('receipt', 'receipt', 10000, { groupId: 'two' }),
      record('card', 'card', 10000, { groupId: 'two' }),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.kind === 'missing_evidence')).toBe(true);
    expect(results.every((result) => result.differenceCents === null)).toBe(true);
  });

  it('does not treat an order as a missing receipt or a mismatch as a loss', () => {
    const [result] = analyze([
      record('claim', 'expense', 9000), record('order', 'order', 9000), record('card', 'card', 9000),
    ]);
    expect(result.kind).toBe('missing_evidence');
    expect(result.differenceCents).toBeNull();
    expect(result.actualCents).toBeNull();
  });

  it('withholds comparisons for mixed currencies', () => {
    const [result] = analyze([
      record('claim', 'expense', 10000), record('receipt', 'receipt', 10000, { currency: 'EUR' }),
      record('card', 'card', 10000),
    ]);
    expect(result.kind).toBe('ambiguous');
    expect(result.currency).toBe('MIXED');
    expect(result.differenceCents).toBeNull();
  });

  it('does not add duplicate-looking charges to invent a discrepancy', () => {
    const [result] = analyze([
      record('claim', 'expense', 10000), record('receipt', 'receipt', 10000),
      record('card1', 'card', 10000), record('card2', 'card', 10000),
    ]);
    expect(result.kind).toBe('ambiguous');
    expect(result.differenceCents).toBeNull();
  });

  it('accepts distinct references for otherwise identical split shipments', () => {
    const [result] = analyze([
      record('claim', 'expense', 20000), record('order', 'order', 20000),
      record('receipt1', 'receipt', 10000, { reference: 'ship-1' }),
      record('receipt2', 'receipt', 10000, { reference: 'ship-2' }),
      record('card1', 'card', 10000, { reference: 'ship-1' }),
      record('card2', 'card', 10000, { reference: 'ship-2' }),
    ]);
    expect(result.kind).toBe('split_purchase');
    expect(result.differenceCents).toBe(0);
  });

  it('keeps the sign of a below-evidence expense and uses integer arithmetic', () => {
    const [result] = analyze([
      record('claim', 'expense', 29), record('receipt', 'receipt', 30), record('card', 'card', 30),
    ]);
    expect(result.differenceCents).toBe(-1);
  });

  it('asks for context when the order differs but the paid and submitted amounts agree', () => {
    const [result] = analyze([
      record('claim', 'expense', 12000), record('receipt', 'receipt', 12000),
      record('card', 'card', 12000), record('order', 'order', 30000),
    ]);
    expect(result.kind).toBe('missing_evidence');
    expect(result.differenceCents).toBeNull();
  });

  it('compares card movement to receipt evidence before checking the claim', () => {
    const [result] = analyze([
      record('claim', 'expense', 11000), record('receipt', 'receipt', 10000), record('card', 'card', 11000),
    ]);
    expect(result.title).toBe('Card and receipt amounts differ');
    expect(result.expectedCents).toBe(10000);
    expect(result.actualCents).toBe(11000);
  });

  it('withholds totals for repeated IDs and excessive refunds', () => {
    expect(analyze([record('same', 'card', 100), record('same', 'receipt', 100)])[0].kind).toBe('ambiguous');
    const [result] = analyze([
      record('claim', 'expense', 100), record('receipt', 'receipt', 100), record('card', 'card', 100),
      record('refund', 'refund', 200),
    ]);
    expect(result.kind).toBe('ambiguous');
    expect(result.differenceCents).toBeNull();
  });
});

describe('CSV import and export', () => {
  it('round-trips quotes, commas, multiline evidence, references, and exact cents', () => {
    const original = [record('one', 'expense', 101, {
      merchant: 'Cafe, "North"', description: 'First line\nSecond line', reference: 'R-123',
    })];
    const result = parseCsvRecords(`\uFEFF${recordsToCsv(original)}`, 'upload.csv');
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual(original);
  });

  it('parses financial decimal amounts without floating-point multiplication', () => {
    const csv = recordsToCsv([record('one', 'expense', 29), record('two', 'refund', 101)]);
    const result = parseCsvRecords(csv, 'upload.csv');
    expect(result.records.map((row) => row.amountCents)).toEqual([29, 101]);
  });

  it.each(['-1.00', '0.00', '1.001', '1e2', '$10.00', '90071992547409.92'])('rejects invalid amount %s without partial import', (badAmount) => {
    const valid = record('valid', 'expense', 100);
    const invalid = record('invalid', 'receipt', 200);
    const csv = recordsToCsv([valid, invalid]).replace(',2.00,', `,${badAmount},`);
    const result = parseCsvRecords(csv, 'upload.csv');
    expect(result.records).toEqual([]);
    expect(result.errors.some((error) => error.includes('amount'))).toBe(true);
  });

  it('rejects invalid calendar dates and duplicate record IDs', () => {
    const csv = recordsToCsv([
      record('same', 'expense', 100), record('same', 'receipt', 100, { date: '2026-02-30' }),
    ]);
    const result = parseCsvRecords(csv, 'upload.csv');
    expect(result.records).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(' ')).toMatch(/date/);
    expect(result.errors.join(' ')).toMatch(/duplicate record ID/);
  });

  it('rejects malformed quoting and malformed rows', () => {
    expect(parseCsvRecords('id,groupId\n"unclosed', 'upload.csv').errors[0]).toMatch(/not closed/);
    const csv = `${recordsToCsv([record('one', 'expense', 100)])}\r\ntoo,few,fields`;
    expect(parseCsvRecords(csv, 'upload.csv').records).toEqual([]);
  });

  it('rejects duplicate headers, invalid currencies, and unknown source types', () => {
    const csv = recordsToCsv([record('one', 'expense', 100)]);
    expect(parseCsvRecords(csv.replace('id,groupId', 'id,id'), 'upload.csv').records).toEqual([]);
    expect(parseCsvRecords(csv.replace(',USD,', ',US,').replace(',expense,', ',transfer,'), 'upload.csv').errors).toHaveLength(2);
  });

  it('accepts a real leap date and falls back to the upload filename', () => {
    const csv = recordsToCsv([record('one', 'expense', 100, { date: '2024-02-29', fileName: '', currency: 'usd' })]);
    const result = parseCsvRecords(csv, 'upload.csv');
    expect(result.errors).toEqual([]);
    expect(result.records[0].currency).toBe('USD');
    expect(result.records[0].fileName).toBe('upload.csv');
  });
});
