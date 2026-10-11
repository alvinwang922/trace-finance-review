export type RecordSource = 'expense' | 'card' | 'receipt' | 'order' | 'refund';

/** Amounts are positive integer hundredths. Refunds are subtracted by the engine. */
export interface SourceRecord {
  id: string;
  groupId: string;
  date: string;
  merchant: string;
  employee: string;
  source: RecordSource;
  amountCents: number;
  currency: string;
  description: string;
  fileName: string;
  reference?: string;
  /** Card network from the statement (e.g. Visa). Optional; used for outside-event research. */
  network?: string;
  /** Payment processor or platform from the descriptor (e.g. Toast, InvoiceCloud). Optional. */
  processor?: string;
}

export interface Dataset {
  id: string;
  name: string;
  records: SourceRecord[];
  isDemo: boolean;
}

export type CaseKind =
  | 'amount_difference'
  | 'split_purchase'
  | 'missing_evidence'
  | 'ambiguous'
  | 'matched';

export interface ReviewCase {
  id: string;
  groupId: string;
  merchant: string;
  employee: string;
  currency: string;
  kind: CaseKind;
  title: string;
  summary: string;
  evidence: string[];
  recordIds: string[];
  /** Actual minus expected, not a finding of money lost or owed. */
  differenceCents: number | null;
  /** Supported comparison amount; inspect evidence for the comparison's source. */
  expectedCents: number | null;
  /** Expense claim, or net card charges when those disagree with receipts. */
  actualCents: number | null;
  nextQuestion: string | null;
}
