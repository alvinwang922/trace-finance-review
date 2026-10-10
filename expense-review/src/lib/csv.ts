import type { RecordSource, SourceRecord } from './types';

export interface CsvParseResult {
  records: SourceRecord[];
  errors: string[];
}

const columns = ['id', 'groupId', 'date', 'merchant', 'employee', 'source', 'amount', 'currency', 'description', 'fileName', 'reference'];
const requiredColumns = ['id', 'groupId', 'date', 'merchant', 'employee', 'source', 'amount', 'currency', 'description'];
const validSources = new Set<RecordSource>(['expense', 'card', 'receipt', 'order', 'refund']);

function readCsv(text: string): { rows: { values: string[]; line: number }[]; errors: string[] } {
  const input = text.replace(/^\uFEFF/, '');
  const rows: { values: string[]; line: number }[] = [];
  const errors: string[] = [];
  let values: string[] = [];
  let value = '';
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;

  function finishField() {
    values.push(value);
    value = '';
    afterQuote = false;
  }
  function finishRow() {
    finishField();
    if (values.some((field) => field.trim() !== '')) rows.push({ values, line: rowLine });
    values = [];
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        value += character;
        if (character === '\n') line += 1;
        else if (character === '\r' && input[index + 1] !== '\n') line += 1;
      }
      continue;
    }
    if (character === ',') {
      finishField();
    } else if (character === '\n' || character === '\r') {
      finishRow();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      line += 1;
      rowLine = line;
    } else if (character === '"') {
      if (value.length || afterQuote) errors.push(`Line ${line}: a quote appears inside an unquoted field.`);
      else inQuotes = true;
    } else if (afterQuote) {
      if (character !== ' ' && character !== '\t') errors.push(`Line ${line}: unexpected text after a quoted field.`);
    } else {
      value += character;
    }
  }
  if (inQuotes) errors.push(`Line ${rowLine}: quoted field is not closed.`);
  if (value.length || values.length || afterQuote) finishRow();
  return { rows, errors: [...new Set(errors)] };
}

function parseAmount(input: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;
  const [whole, fractional = ''] = input.split('.');
  const cents = Number(`${whole}${fractional.padEnd(2, '0')}`);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function isDate(input: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || input.startsWith('0000')) return false;
  const parsed = new Date(`${input}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input;
}

/** Parse a combined records CSV. Any error rejects the complete import. */
export function parseCsvRecords(text: string, fileName: string): CsvParseResult {
  const parsed = readCsv(text);
  if (parsed.errors.length) return { records: [], errors: parsed.errors };
  if (!parsed.rows.length) return { records: [], errors: ['The CSV is empty.'] };
  const [headerRow, ...rows] = parsed.rows;
  const headers = headerRow.values.map((value) => value.trim());
  const errors: string[] = [];
  const repeatedHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (repeatedHeaders.length) errors.push(`Duplicate columns: ${[...new Set(repeatedHeaders)].join(', ')}.`);
  const missingHeaders = requiredColumns.filter((column) => !headers.includes(column));
  if (missingHeaders.length) errors.push(`Missing required columns: ${missingHeaders.join(', ')}.`);
  if (errors.length) return { records: [], errors };
  if (!rows.length) return { records: [], errors: ['The CSV has a header but no records.'] };

  const records: SourceRecord[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (row.values.length !== headers.length) {
      errors.push(`Line ${row.line}: expected ${headers.length} fields, found ${row.values.length}.`);
      continue;
    }
    const values = Object.fromEntries(headers.map((header, index) => [header, row.values[index].trim()]));
    const prefix = `Line ${row.line}: `;
    const errorsBefore = errors.length;
    for (const field of ['id', 'groupId', 'merchant']) {
      if (!values[field]) errors.push(`${prefix}${field} is required.`);
    }
    if (seenIds.has(values.id)) errors.push(`${prefix}duplicate record ID ${values.id}.`);
    seenIds.add(values.id);
    if (!isDate(values.date)) errors.push(`${prefix}date must be a real date in YYYY-MM-DD format.`);
    if (!validSources.has(values.source as RecordSource)) {
      errors.push(`${prefix}source must be expense, card, receipt, order, or refund.`);
    }
    const amountCents = parseAmount(values.amount);
    if (amountCents === null) {
      errors.push(`${prefix}amount must be positive, with at most two decimal places, no currency symbol or separators, and within supported precision.`);
    }
    const currency = values.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) errors.push(`${prefix}currency must be a three-letter code such as USD.`);
    if (errors.length !== errorsBefore || amountCents === null) continue;
    records.push({
      id: values.id,
      groupId: values.groupId,
      date: values.date,
      merchant: values.merchant,
      employee: values.employee,
      source: values.source as RecordSource,
      amountCents,
      currency,
      description: values.description,
      fileName: values.fileName || fileName,
      ...(values.reference ? { reference: values.reference } : {}),
    });
  }
  return errors.length ? { records: [], errors } : { records, errors: [] };
}

function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function recordsToCsv(records: SourceRecord[]): string {
  const rows = records.map((record) => {
    if (!Number.isSafeInteger(record.amountCents) || record.amountCents <= 0) {
      throw new Error(`Record ${record.id} does not contain a positive integer-cent amount.`);
    }
    const values: Record<string, string | number> = {
      ...record,
      amount: `${Math.floor(record.amountCents / 100)}.${String(record.amountCents % 100).padStart(2, '0')}`,
      reference: record.reference ?? '',
    };
    return columns.map((column) => escapeField(String(values[column] ?? ''))).join(',');
  });
  return [columns.join(','), ...rows].join('\r\n');
}
