import type { Dataset, RecordSource, ReviewCase, SourceRecord } from './types';

const sources: RecordSource[] = ['expense', 'card', 'receipt', 'order', 'refund'];

function formatAmount(cents: number, currency: string): string {
  const sign = cents < 0 ? '−' : '';
  const absolute = Math.abs(cents);
  return `${currency} ${sign}${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function total(records: SourceRecord[]): number | null {
  let amount = 0;
  for (const record of records) {
    amount += record.amountCents;
    if (!Number.isSafeInteger(amount)) return null;
  }
  return amount;
}

/** Duplicate-looking rows remain unresolved; no description text is treated as proof. */
function duplicateReason(records: SourceRecord[]): string | null {
  for (let index = 0; index < records.length; index += 1) {
    const first = records[index];
    for (const second of records.slice(index + 1)) {
      if (first.source !== second.source) continue;
      const firstRef = first.reference?.trim();
      const secondRef = second.reference?.trim();
      if (firstRef && secondRef && firstRef === secondRef) {
        return `The ${first.source} reference ${firstRef} appears more than once.`;
      }
      const sameDetails = first.date === second.date
        && first.amountCents === second.amountCents
        && normalize(first.merchant) === normalize(second.merchant)
        && normalize(first.employee) === normalize(second.employee);
      const distinctReferences = Boolean(firstRef && secondRef && firstRef !== secondRef);
      if (sameDetails && !distinctReferences) {
        return `Two ${first.source} rows have the same date, amount, and merchant without distinct references.`;
      }
    }
  }
  return null;
}

function analyzeGroup(
  datasetId: string,
  groupId: string,
  records: SourceRecord[],
  repeatedIds: Set<string>,
): ReviewCase {
  const first = records[0];
  const currencies = [...new Set(records.map((record) => record.currency))];
  const currency = currencies.length === 1 ? currencies[0] : 'MIXED';
  const sourceEvidence = records.map((record) => {
    const amount = Number.isSafeInteger(record.amountCents)
      ? formatAmount(record.amountCents, record.currency)
      : 'invalid amount';
    return `${record.source}: ${amount} · ${record.date} · ${record.fileName}${record.reference ? ` · ref ${record.reference}` : ''} · record ${record.id}`;
  });
  const base: ReviewCase = {
    id: `${encodeURIComponent(datasetId)}:${encodeURIComponent(groupId)}`,
    groupId,
    merchant: first.merchant,
    employee: [...new Set(records.map((record) => record.employee).filter(Boolean))].join(', '),
    currency,
    kind: 'ambiguous',
    title: 'Review the linked records',
    summary: '',
    evidence: sourceEvidence,
    recordIds: records.map((record) => record.id),
    differenceCents: null,
    expectedCents: null,
    actualCents: null,
    nextQuestion: null,
  };

  function unresolved(
    kind: 'ambiguous' | 'missing_evidence',
    title: string,
    summary: string,
    nextQuestion: string,
  ): ReviewCase {
    return { ...base, kind, title, summary, nextQuestion };
  }

  if (!groupId.trim()) {
    return unresolved('ambiguous', 'Relationship not established',
      'These records do not have a group ID. Similar amounts or merchants do not establish a relationship.',
      'Which records belong to the same purchase? Add an explicit group ID.');
  }
  if (records.some((record) => !record.id.trim() || repeatedIds.has(record.id))) {
    return unresolved('ambiguous', 'Record identifiers need review',
      'A record ID is missing or repeated. Totals are withheld to avoid counting the same record twice.',
      'Are these separate source records, or duplicate imports?');
  }
  if (currencies.length !== 1 || !/^[A-Z]{3}$/.test(currency)) {
    return unresolved('ambiguous', 'Currencies cannot be compared',
      'The group contains mixed or invalid currency codes. No conversion rate has been assumed.',
      'Can you provide the settlement currency and documented conversion for these records?');
  }
  if (records.some((record) => !sources.includes(record.source)
    || !Number.isSafeInteger(record.amountCents) || record.amountCents <= 0)) {
    return unresolved('ambiguous', 'A source amount needs review',
      'Every record needs a recognized source and a positive amount in integer cents. Refunds must be separate positive refund records.',
      'Can you correct the invalid source record before comparing totals?');
  }

  const bySource = Object.fromEntries(sources.map((source) => [
    source, records.filter((record) => record.source === source),
  ])) as Record<RecordSource, SourceRecord[]>;
  const duplicate = duplicateReason(records);
  if (duplicate) {
    return unresolved('ambiguous', 'Possible duplicate or separate charge', duplicate,
      'Can you confirm whether these are separate transactions and provide distinct source references?');
  }
  if (bySource.expense.length > 1 || bySource.order.length > 1) {
    if (bySource.expense.length > 1 && bySource.card.length > 1 && !bySource.receipt.length) {
      const firstCard = bySource.card[0];
      const cardAmount = formatAmount(firstCard.amountCents, currency);
      return unresolved('ambiguous', 'Possible duplicate card charge',
        `There are ${bySource.expense.length} expense submissions and ${bySource.card.length} card charges, but no receipt evidence. The card charges share the same merchant, date, and amount pattern, so Trace cannot tell whether this is a duplicate, a separate purchase, or a pre-authorization hold.`,
        `Your card was charged ${cardAmount} twice at ${firstCard.merchant} on ${firstCard.date}. Were these two separate purchases?`);
    }
    return unresolved('ambiguous', 'More than one claimed total',
      'This group contains multiple expense or order totals. The app cannot tell whether they are separate purchases, line items, or revisions.',
      'Which expense and order total should apply to this purchase?');
  }

  const sums = Object.fromEntries(
    sources.map((source) => [source, total(bySource[source])]),
  ) as Record<RecordSource, number | null>;
  if (Object.values(sums).some((amount) => amount === null)) {
    return unresolved('ambiguous', 'Total exceeds supported precision',
      'The total is too large to compare safely using integer cents.',
      'Can you split this dataset into smaller purchase groups?');
  }
  const amount = sums as Record<RecordSource, number>;
  const missing: string[] = [];
  if (!bySource.expense.length) missing.push('expense submission');
  if (!bySource.card.length) missing.push('card charge');
  if (!bySource.receipt.length) missing.push('receipt');
  if (missing.length) {
    return unresolved('missing_evidence', `Missing ${missing.join(' and ')}`,
      `This purchase is missing ${missing.join(', ')} evidence. A matching order total alone would not verify the final purchase amount.`,
      `Can you provide the ${missing.join(' and ')} for this purchase?`);
  }
  if (amount.refund > amount.card || amount.refund > amount.receipt) {
    return unresolved('ambiguous', 'Refund exceeds the linked purchase',
      'The linked refund total exceeds the card charges or receipt total. The purchase may be incomplete or incorrectly grouped.',
      'Which original charges and receipts do these refunds belong to?');
  }

  const netCard = amount.card - amount.refund;
  const netReceipts = amount.receipt - amount.refund;
  const calculatedEvidence = [
    `Submitted expense: ${formatAmount(amount.expense, currency)}.`,
    `Receipts: ${formatAmount(amount.receipt, currency)}${bySource.receipt.length > 1 ? ` across ${bySource.receipt.length} records` : ''}.`,
    `Card charges: ${formatAmount(amount.card, currency)}; refunds: ${formatAmount(amount.refund, currency)}; net card amount: ${formatAmount(netCard, currency)}.`,
    ...(bySource.order.length ? [`Order: ${formatAmount(amount.order, currency)}. The order is compared separately, not added to receipts.`] : []),
    ...sourceEvidence,
  ];

  // First establish that the receipt evidence agrees with actual card movement.
  if (netCard !== netReceipts) {
    return {
      ...base,
      kind: 'amount_difference',
      title: 'Card and receipt amounts differ',
      summary: `The net card amount is ${formatAmount(netCard, currency)} and the receipt amount after recorded refunds is ${formatAmount(netReceipts, currency)}. The difference needs review; its cause is not established.`,
      evidence: calculatedEvidence,
      differenceCents: netCard - netReceipts,
      expectedCents: netReceipts,
      actualCents: netCard,
      nextQuestion: `The card and receipt totals differ by ${formatAmount(Math.abs(netCard - netReceipts), currency)}. Is there an updated receipt, adjustment, or additional charge explaining that difference?`,
    };
  }

  if (amount.expense !== netCard) {
    const difference = Math.abs(amount.expense - netCard);
    const descriptions = records.map((record) => record.description.toLowerCase()).join(' ');
    const hasTipOrFeeSignal = /tip|gratuity|service fee|surcharge/.test(descriptions);
    const nextQuestion = hasTipOrFeeSignal
      ? `The submitted amount is ${formatAmount(amount.expense, currency)} while the card and receipt support ${formatAmount(netCard, currency)}. Was the ${formatAmount(difference, currency)} difference a tip, service fee, or surcharge entered differently?`
      : difference % 900 === 0
        ? `The records support ${formatAmount(netCard, currency)}, but ${formatAmount(amount.expense, currency)} was submitted. Could ${formatAmount(netCard, currency)} have been entered as ${formatAmount(amount.expense, currency)}?`
        : `The submitted amount is ${formatAmount(amount.expense, currency)} while the card and receipt support ${formatAmount(netCard, currency)}. What explains the ${formatAmount(difference, currency)} difference?`;
    return {
      ...base,
      kind: 'amount_difference',
      title: 'Submitted amount differs from the evidence',
      summary: `The expense claims ${formatAmount(amount.expense, currency)}. Card records and receipts both support ${formatAmount(netCard, currency)} after recorded refunds. This identifies a difference, not its cause or money lost.`,
      evidence: calculatedEvidence,
      differenceCents: amount.expense - netCard,
      expectedCents: netCard,
      actualCents: amount.expense,
      nextQuestion,
    };
  }

  if (bySource.order.length && amount.order !== amount.receipt) {
    return {
      ...unresolved('missing_evidence', 'Order and receipts need context',
        'The submitted expense, receipts, and net card amount agree, but the order total differs from the receipts. The app cannot establish whether all shipments or order adjustments are included.',
        'Can you provide the remaining shipment, cancellation, or adjusted order details?'),
      evidence: calculatedEvidence,
    };
  }

  const isSplit = bySource.card.length > 1 || bySource.receipt.length > 1;
  return {
    ...base,
    kind: isSplit ? 'split_purchase' : 'matched',
    title: isSplit ? 'Split purchase explained' : bySource.refund.length ? 'Refund explains the amount' : 'Amounts agree',
    summary: isSplit
      ? `The linked charges and receipts add up to ${formatAmount(amount.card, currency)}. After ${formatAmount(amount.refund, currency)} in recorded refunds, the ${formatAmount(netCard, currency)} net amount agrees with the expense.`
      : `The expense, receipts, and card records agree at ${formatAmount(netCard, currency)}${bySource.refund.length ? ' after recorded refunds' : ''}. This verifies amounts, not business purpose or policy compliance.`,
    evidence: calculatedEvidence,
    differenceCents: 0,
    expectedCents: netCard,
    actualCents: amount.expense,
    nextQuestion: null,
  };
}

/** Only explicit group IDs establish relationships. No merchant-based auto-grouping. */
export function analyzeDataset(dataset: Dataset): ReviewCase[] {
  const groups = new Map<string, SourceRecord[]>();
  const seenIds = new Set<string>();
  const repeatedIds = new Set<string>();
  for (const record of dataset.records) {
    if (seenIds.has(record.id)) repeatedIds.add(record.id);
    seenIds.add(record.id);
    const group = groups.get(record.groupId) ?? [];
    group.push(record);
    groups.set(record.groupId, group);
  }
  return [...groups].map(([groupId, records]) => analyzeGroup(dataset.id, groupId, records, repeatedIds));
}
