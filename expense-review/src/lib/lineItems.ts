import type { SourceRecord } from './types';

/**
 * Line-by-line comparison. Totals say that a claim and a receipt differ; line items say
 * where. Amounts are read only from labeled values in the record text ("Meal $100.00",
 * "$21.40 tip", "total $112.00"); anything unlabeled is ignored rather than guessed.
 */

export type LineCategory = 'base' | 'tip' | 'tax' | 'fee' | 'total';

export interface ParsedLines {
  values: Partial<Record<LineCategory, number>>;
  /** The record says the tip line was left blank. */
  tipBlank: boolean;
  /** The word used for the item line, e.g. "Meal". */
  baseLabel?: string;
}

export interface LineRow {
  category: LineCategory;
  label: string;
  claimedCents: number | null;
  receiptCents: number | null;
  status: 'match' | 'differs' | 'only_claim' | 'only_receipt';
}

export interface LineComparison {
  rows: LineRow[];
  /** Plain-language cause, only when the lines account for the whole difference. */
  explanation: string | null;
  cause: 'tip' | 'tax' | 'fee' | 'base' | 'swapped_digits' | 'tip_after_receipt' | null;
  /** A neutral question that names the line, when one is needed. */
  question: string | null;
}

const KEYWORDS: [LineCategory, RegExp][] = [
  ['tip', /^(tip|tips|gratuity)$/i],
  ['tax', /^(tax|taxes|vat)$/i],
  ['fee', /^(fee|fees|surcharge)$/i],
  ['total', /^total$/i],
  ['base', /^(meal|meals|food|lunch|dinner|breakfast|materials|banners|subtotal|items|rental)$/i],
];
const LABELS: Record<LineCategory, string> = { base: 'Items', tip: 'Tip', tax: 'Tax', fee: 'Fees', total: 'Total' };

function category(word: string | undefined): LineCategory | null {
  if (!word) return null;
  const clean = word.replace(/[^A-Za-z]/g, '');
  return KEYWORDS.find(([, pattern]) => pattern.test(clean))?.[0] ?? null;
}

function money(cents: number, currency = 'USD'): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseLineItems(record: Pick<SourceRecord, 'description' | 'amountCents'>): ParsedLines {
  const text = record.description || '';
  const values: ParsedLines['values'] = {};
  let baseLabel: string | undefined;
  for (const match of text.matchAll(/\$(\d[\d,]*\.\d{2})/g)) {
    const cents = Math.round(Number(match[1].replace(/,/g, '')) * 100);
    const before = text.slice(0, match.index).trimEnd();
    const after = text.slice((match.index ?? 0) + match[0].length);
    // A label right after the amount wins ("$21.40 tip"), unless punctuation separates them.
    const next = /^[;,.:]/.test(after) ? undefined : after.trim().split(/\s+/)[0];
    const previous = before.split(/\s+/).slice(-2).reverse();
    const found = category(next) ?? (/[;,.:]$/.test(before) ? null : category(previous[0]) ?? category(previous[1]));
    if (found === 'base' && !baseLabel) {
      const word = [next, ...previous].find((item) => category(item) === 'base')?.replace(/[^A-Za-z]/g, '') ?? '';
      baseLabel = word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : undefined;
    }
    if (found && values[found] === undefined) values[found] = cents;
    else if (!found && cents === record.amountCents && values.total === undefined) values.total = cents;
  }
  return { values, baseLabel, tipBlank: /tip line (is )?blank|no tip (was )?(written|entered)/i.test(text) };
}

/** True when the two amounts differ only by two swapped digits, e.g. 268.50 and 286.50. */
export function swappedDigits(a: number, b: number): [string, string] | null {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length || x === y) return null;
  const diff = [...x].map((char, index) => (char === y[index] ? -1 : index)).filter((index) => index >= 0);
  if (diff.length !== 2) return null;
  const [i, j] = diff;
  return x[i] === y[j] && x[j] === y[i] ? [x[i], x[j]] : null;
}

export function compareLineItems(records: SourceRecord[]): LineComparison | null {
  const expenses = records.filter((record) => record.source === 'expense');
  const receipts = records.filter((record) => record.source === 'receipt');
  const cards = records.filter((record) => record.source === 'card');
  const refunds = records.filter((record) => record.source === 'refund');
  if (expenses.length !== 1 || receipts.length !== 1 || refunds.length) return null;
  const [expense] = expenses;
  const [receipt] = receipts;
  const currency = expense.currency;
  const claim = parseLineItems(expense);
  const paper = parseLineItems(receipt);
  claim.values.total ??= expense.amountCents;
  paper.values.total ??= receipt.amountCents;
  const cardTotal = cards.reduce((total, record) => total + record.amountCents, 0);

  // Fill an unlabeled item amount from the total when every other line is known.
  for (const side of [claim, paper]) {
    const { values } = side;
    const parts = (['tip', 'tax', 'fee'] as const).reduce((total, key) => total + (values[key] ?? 0), 0);
    if (values.base === undefined && values.total !== undefined && parts > 0) values.base = values.total - parts;
  }

  const order: LineCategory[] = ['base', 'tax', 'fee', 'tip', 'total'];
  const rows: LineRow[] = order
    .filter((key) => claim.values[key] !== undefined || paper.values[key] !== undefined)
    .map((key) => {
      const claimedCents = claim.values[key] ?? null;
      const receiptCents = paper.values[key] ?? null;
      const status: LineRow['status'] = claimedCents === null ? 'only_receipt' : receiptCents === null ? 'only_claim'
        : claimedCents === receiptCents ? 'match' : 'differs';
      const label = key === 'base' ? claim.baseLabel ?? paper.baseLabel ?? LABELS.base : LABELS[key];
      return { category: key, label, claimedCents, receiptCents, status };
    });

  const claimTotal = claim.values.total ?? expense.amountCents;
  const paperTotal = paper.values.total ?? receipt.amountCents;
  const gap = claimTotal - paperTotal;
  let explanation: string | null = null;
  let cause: LineComparison['cause'] = null;
  let question: string | null = null;

  if (gap !== 0) {
    const differing = rows.filter((row) => row.category !== 'total' && row.status === 'differs');
    const lineGap = differing.reduce((total, row) => total + ((row.claimedCents ?? 0) - (row.receiptCents ?? 0)), 0);
    const swap = swappedDigits(claimTotal, paperTotal);
    if (differing.length === 1 && lineGap === gap) {
      const [row] = differing;
      cause = row.category === 'total' ? null : row.category as LineComparison['cause'];
      const matched = rows.filter((item) => item.category !== 'total' && item.status === 'match').map((item) => item.label.toLowerCase());
      const cardNote = cards.length && cardTotal === paperTotal ? ` The card charge matches the receipt at ${money(cardTotal, currency)}.` : '';
      explanation = `${matched.length ? `${matched.join(' and ')[0].toUpperCase()}${matched.join(' and ').slice(1)} match${matched.length === 1 ? 'es' : ''}. ` : ''}The whole ${money(Math.abs(gap), currency)} difference is in the ${row.label.toLowerCase()} line: ${money(row.claimedCents ?? 0, currency)} claimed vs ${money(row.receiptCents ?? 0, currency)} on the receipt.${cardNote}`;
      question = `The receipt${cardNote ? ' and card' : ''} show${cardNote ? '' : 's'} a ${money(row.receiptCents ?? 0, currency)} ${row.label.toLowerCase()}, but the expense lists ${money(row.claimedCents ?? 0, currency)}. Which ${row.label.toLowerCase()} amount is right?`;
    } else if (swap) {
      cause = 'swapped_digits';
      explanation = `The digits ${swap[0]} and ${swap[1]} are swapped: the receipt${cards.length && cardTotal === paperTotal ? ' and card' : ''} support ${money(paperTotal, currency)}, entered as ${money(claimTotal, currency)}. A typing slip, not a different amount.`;
      question = `Could ${money(paperTotal, currency)} have been entered as ${money(claimTotal, currency)}?`;
    }
  } else if (cards.length && cardTotal > paperTotal) {
    const extra = cardTotal - paperTotal;
    const share = Math.round((extra / paperTotal) * 100);
    if (paper.tipBlank || (share >= 10 && share <= 30)) {
      cause = 'tip_after_receipt';
      explanation = `The claim matches the receipt, but the card settled ${money(extra, currency)} (${share}%) higher.${paper.tipBlank ? ' The receipt’s tip line is blank,' : ' This is in the usual tip range,'} so the tip was most likely added after the receipt was captured. The company card paid the full amount; no one gained.`;
      question = `Was the ${money(extra, currency)} difference a tip added after the receipt photo? If so, a photo of the signed copy will close this.`;
    }
  }
  if (rows.length < 2 && !cause) return null;
  return { rows, explanation, cause, question };
}
