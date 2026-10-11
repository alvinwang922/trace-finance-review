import type { Dataset, ReviewCase, SourceRecord } from './types';

/**
 * World context: before anyone is contacted, look for mismatches that share an outside
 * factor (same card network or processor, same few days) across different employees,
 * then check the public web for an outside cause. Grouping and scoring are deterministic
 * so every ruling can be traced to a matched source; the web search itself runs through
 * Bright Data on the server.
 */

export type ClusterSignature = 'duplicate_settlement' | 'tip_after_authorization';

export interface ClusterCase {
  groupId: string;
  caseId: string;
  employee: string;
  merchant: string;
  /** Earliest card posting date for the case. */
  date: string;
  /** The amount in question: the extra posting, or the gap between card and receipt. */
  amountCents: number;
  currency: string;
}

export interface Hypothesis {
  kind: 'incident' | 'mechanism';
  label: string;
  queries: string[];
}

export interface WorldCluster {
  id: string;
  signature: ClusterSignature;
  title: string;
  why: string;
  network: string | null;
  processor: string | null;
  windowStart: string;
  windowEnd: string;
  employees: string[];
  cases: ClusterCase[];
  totalCents: number;
  currency: string;
  hypothesis: Hypothesis;
}

export interface WorldContext {
  clusters: WorldCluster[];
  /** Mismatches with no shared outside factor. They stay with a reviewer. */
  isolated: ReviewCase[];
}

export interface SearchHit { query: string; url: string; title: string; snippet: string }
export interface ScrapedPage { url: string; text: string }

export interface ScoredSource extends SearchHit {
  score: number;
  strong: boolean;
  matched: { event: boolean; date: boolean; network: boolean; processor: boolean };
}

export interface Ruling {
  verdict: 'outside_event' | 'shared_mechanism' | 'no_outside_cause';
  headline: string;
  detail: string;
  quote: string | null;
  sourceUrl: string | null;
  actions: string[];
}

export interface ResearchStep { kind: 'plan' | 'search' | 'score' | 'read' | 'rule' | 'error'; text: string }

export interface ResearchRun {
  clusterId: string;
  mode: 'live' | 'recorded';
  startedAt: string;
  finishedAt: string;
  steps: ResearchStep[];
  sources: ScoredSource[];
  ruling: Ruling;
}

export interface ResearchTransport {
  search(queries: string[]): Promise<SearchHit[]>;
  scrape(urls: string[]): Promise<ScrapedPage[]>;
}

const DAY_MS = 86_400_000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ALIASES: Record<string, number> = {
  jan: 0, ene: 0, feb: 1, mar: 2, apr: 3, abr: 3, may: 4, jun: 5, jul: 6, aug: 7, ago: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11, dic: 11,
};
MONTHS.forEach((name, index) => { MONTH_ALIASES[name] = index; });

const SOCIAL = /(^|\.)(instagram|facebook|youtube|tiktok|x|twitter|threads)\.com$/i;
const EVENT_TERMS: Record<ClusterSignature, RegExp[]> = {
  duplicate_settlement: [/duplicat|charged twice|double[- ]?charg|withdrawn twice|processed twice|charged two times/i],
  // "Authorization" as the card hold, not a manager approving a tip.
  tip_after_authorization: [/pre-?auth|authori[sz]ation|\bhold\b|pending|final (charge|amount)|settle|batch/i, /\btip|gratuit/i],
};

function money(cents: number, currency: string): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sum(records: SourceRecord[]): number {
  return records.reduce((total, record) => total + record.amountCents, 0);
}

function days(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

function longDate(iso: string): { month: string; day: number; year: number } {
  const date = new Date(`${iso}T00:00:00Z`);
  return { month: MONTHS[date.getUTCMonth()][0].toUpperCase() + MONTHS[date.getUTCMonth()].slice(1), day: date.getUTCDate(), year: date.getUTCFullYear() };
}

export function describeWindow(start: string, end: string): string {
  const a = longDate(start);
  const b = longDate(end);
  if (start === end) return `${a.month} ${a.day}, ${a.year}`;
  return a.month === b.month ? `${a.month} ${a.day}–${b.day}, ${a.year}` : `${a.month} ${a.day} – ${b.month} ${b.day}, ${b.year}`;
}

function cardMeta(records: SourceRecord[]): { network: string | null; processor: string | null } {
  const card = records.find((record) => record.source === 'card' && (record.network || record.processor));
  return { network: card?.network?.trim() || null, processor: card?.processor?.trim() || null };
}

interface Signal { signature: ClusterSignature; case: ClusterCase; network: string | null; processor: string | null }

/** One extra card posting with the same amount, within two days, on top of an otherwise matching purchase. */
function duplicateSignal(records: SourceRecord[]): { amountCents: number; date: string } | null {
  const cards = records.filter((record) => record.source === 'card').sort((a, b) => a.date.localeCompare(b.date));
  const expense = sum(records.filter((record) => record.source === 'expense'));
  const receipts = sum(records.filter((record) => record.source === 'receipt'));
  if (cards.length < 2 || !expense || records.some((record) => record.source === 'refund')) return null;
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const same = cards[i].amountCents === cards[j].amountCents && days(cards[i].date, cards[j].date) <= 2;
      if (same && sum(cards) - cards[i].amountCents === expense && (!receipts || receipts === expense)) {
        return { amountCents: cards[i].amountCents, date: cards[i].date };
      }
    }
  }
  return null;
}

/** Card settled 10–30% above a receipt that matches the claim: the tip was added after the receipt was captured. */
function tipSignal(records: SourceRecord[]): { amountCents: number; date: string } | null {
  const cards = records.filter((record) => record.source === 'card');
  const card = sum(cards);
  const receipt = sum(records.filter((record) => record.source === 'receipt'));
  const expense = sum(records.filter((record) => record.source === 'expense'));
  if (!cards.length || !receipt || receipt !== expense || records.some((record) => record.source === 'refund')) return null;
  const ratio = (card - receipt) / receipt;
  if (ratio < 0.1 || ratio > 0.3) return null;
  return { amountCents: card - receipt, date: cards.map((record) => record.date).sort()[0] };
}

function queriesFor(signature: ClusterSignature, network: string | null, processor: string | null, start: string, end: string): Hypothesis {
  const a = longDate(start);
  const b = longDate(end);
  const who = [processor, network].filter(Boolean).join(' ');
  if (signature === 'duplicate_settlement') {
    return {
      kind: 'incident',
      label: `${network || 'Card network'} or ${processor || 'processor'} processing incident around ${describeWindow(start, end)}`,
      queries: [
        `${who} duplicate charges ${a.month} ${a.day}-${b.day} ${a.year}`.trim(),
        `${who} duplicate payments notice to customers ${a.month} ${a.year}`.trim(),
        `${network || 'card'} charged twice ${a.month} ${a.year} processing error`,
      ],
    };
  }
  return {
    kind: 'mechanism',
    label: `${processor || 'Restaurant point-of-sale'} adds the tip after the card is authorized`,
    queries: [
      `${network || 'card'} restaurant tip adjustment final amount higher than authorization`,
      'restaurant card authorized before tip final charge includes tip receipt lower',
    ],
  };
}

export function findWorldContext(dataset: Dataset, cases: ReviewCase[]): WorldContext {
  const byGroup = new Map<string, SourceRecord[]>();
  for (const record of dataset.records) byGroup.set(record.groupId, [...(byGroup.get(record.groupId) ?? []), record]);
  const caseByGroup = new Map(cases.map((reviewCase) => [reviewCase.groupId, reviewCase]));

  const signals: Signal[] = [];
  for (const [groupId, records] of byGroup) {
    const reviewCase = caseByGroup.get(groupId);
    if (!reviewCase) continue;
    const meta = cardMeta(records);
    const base = { groupId, caseId: reviewCase.id, employee: reviewCase.employee, merchant: reviewCase.merchant, currency: reviewCase.currency };
    const duplicate = duplicateSignal(records);
    if (duplicate) { signals.push({ signature: 'duplicate_settlement', case: { ...base, ...duplicate }, ...meta }); continue; }
    const tip = tipSignal(records);
    if (tip) signals.push({ signature: 'tip_after_authorization', case: { ...base, ...tip }, ...meta });
  }

  const clusters: WorldCluster[] = [];
  const buckets = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = `${signal.signature}|${signal.network ?? ''}|${signal.processor ?? ''}`;
    buckets.set(key, [...(buckets.get(key) ?? []), signal]);
  }
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => a.case.date.localeCompare(b.case.date));
    const signature = sorted[0].signature;
    // Incidents must share a short window; a point-of-sale mechanism can repeat all month.
    const windows: Signal[][] = [];
    for (const signal of sorted) {
      const current = windows[windows.length - 1];
      if (current && (signature !== 'duplicate_settlement' || days(current[0].case.date, signal.case.date) <= 3)) current.push(signal);
      else windows.push([signal]);
    }
    for (const group of windows) {
      const employees = [...new Set(group.map((signal) => signal.case.employee))];
      if (employees.length < 2) continue;
      const { network, processor } = group[0];
      const groupCases = group.map((signal) => signal.case);
      const windowStart = groupCases[0].date;
      const windowEnd = groupCases[groupCases.length - 1].date;
      const totalCents = groupCases.reduce((total, item) => total + item.amountCents, 0);
      const via = [network, processor && `via ${processor}`].filter(Boolean).join(' ');
      clusters.push({
        id: `${signature}:${groupCases.map((item) => item.groupId).join('+')}`,
        signature,
        title: signature === 'duplicate_settlement'
          ? `${groupCases.length} duplicate ${network || 'card'} postings, ${employees.length} employees, ${describeWindow(windowStart, windowEnd)}`
          : `${groupCases.length} card charges above the receipt at ${processor || 'restaurant'} merchants, ${employees.length} employees`,
        why: signature === 'duplicate_settlement'
          ? `Different people paid different merchants, yet each payment ${via ? `(${via}) ` : ''}posted twice within the same few days. That points outside the company.`
          : `Each card charge settled 10–30% above a receipt that matches the claim, at ${processor || 'restaurant'} merchants, for different people. That points to how the charge was captured, not to any one person.`,
        network, processor, windowStart, windowEnd, employees, cases: groupCases, totalCents,
        currency: groupCases[0].currency,
        hypothesis: queriesFor(signature, network, processor, windowStart, windowEnd),
      });
    }
  }

  const clustered = new Set(clusters.flatMap((cluster) => cluster.cases.map((item) => item.groupId)));
  const isolated = cases.filter((reviewCase) => reviewCase.kind !== 'matched' && reviewCase.kind !== 'split_purchase' && !clustered.has(reviewCase.groupId));
  return { clusters, isolated };
}

interface MentionedDate { start: number; end: number }

/** Dates such as "April 11–13, 2025", "Apr 17, 2025", "17 abr. 2025" or "APR172025". */
export function mentionedDates(text: string): MentionedDate[] {
  const found: MentionedDate[] = [];
  const add = (monthName: string, startDay: number, endDay: number, year: number) => {
    const month = MONTH_ALIASES[monthName.toLowerCase().replace('.', '')];
    if (month === undefined || year < 2000 || year > 2100 || startDay < 1 || startDay > 31) return;
    found.push({ start: Date.UTC(year, month, startDay), end: Date.UTC(year, month, Math.max(startDay, Math.min(endDay, 31))) });
  };
  for (const match of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*(?:–|-|to)\s*(\d{1,2}))?(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    add(match[1], Number(match[2]), Number(match[3] || match[2]), Number(match[4]));
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) add(match[2], Number(match[1]), Number(match[1]), Number(match[3]));
  for (const match of text.matchAll(/\b([A-Z]{3})(\d{2})(\d{4})\b/g)) add(match[1], Number(match[2]), Number(match[2]), Number(match[3]));
  return found;
}

function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function scoreSources(cluster: WorldCluster, hits: SearchHit[]): ScoredSource[] {
  const start = Date.parse(`${cluster.windowStart}T00:00:00Z`);
  const end = Date.parse(`${cluster.windowEnd}T00:00:00Z`);
  const seen = new Set<string>();
  const scored: ScoredSource[] = [];
  for (const hit of hits) {
    if (!hit.url || seen.has(hit.url)) continue;
    seen.add(hit.url);
    const text = `${hit.title} ${hit.snippet}`;
    const event = EVENT_TERMS[cluster.signature].every((pattern) => pattern.test(text));
    const network = Boolean(cluster.network && new RegExp(`\\b${cluster.network}\\b`, 'i').test(text));
    const processor = Boolean(cluster.processor && new RegExp(`\\b${cluster.processor}\\b`, 'i').test(text));
    // A notice dated within a week after the window that mentions the weekend also counts.
    const date = mentionedDates(text).some((mention) => mention.start <= end + DAY_MS && mention.end >= start - DAY_MS)
      || (/weekend|friday|saturday|sunday/i.test(text) && mentionedDates(text).some((mention) => mention.start >= start && mention.start <= end + 7 * DAY_MS));
    const social = SOCIAL.test(domain(hit.url));
    const strong = cluster.hypothesis.kind === 'incident'
      ? event && (network || processor) && (date || (network && processor))
      : event;
    const score = (event ? 3 : 0) + (date ? 2 : 0) + (network ? 2 : 0) + (processor ? 1 : 0) + (strong ? 2 : 0) - (social ? 3 : 0);
    scored.push({ ...hit, score, strong, matched: { event, date, network, processor } });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** The most relevant one or two sentences from a fetched page. */
export function extractQuote(cluster: WorldCluster, text: string): string | null {
  // Work line by line so headings and navigation never merge into a sentence.
  const sentences = text.split(/\n+/)
    .map((line) => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#*_>`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim())
    .flatMap((line) => line.split(/(?<=[.!?”"])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 40 && sentence.length < 400 && /[.!?”"]$/.test(sentence) && !sentence.includes(' | '));
  const terms = EVENT_TERMS[cluster.signature];
  const matches = (sentence: string) => terms.every((pattern) => pattern.test(sentence));
  const named = (sentence?: string) => Boolean(sentence) && [cluster.network, cluster.processor]
    .some((name) => name && new RegExp(`\\b${name}\\b`, 'i').test(sentence as string));
  const timed = (sentence?: string) => Boolean(sentence) && /friday|saturday|sunday|weekend|\bET\b|\d{1,2},? \d{4}/i.test(sentence as string);

  // Prefer the matching sentence with the most context around it: who was involved and when.
  let best = -1;
  let bestScore = -1;
  sentences.forEach((sentence, index) => {
    if (!matches(sentence)) return;
    const score = (named(sentence) ? 2 : 0) + (named(sentences[index - 1]) ? 2 : 0) + (timed(sentences[index + 1]) || timed(sentence) ? 1 : 0);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  if (best < 0) return null;
  const previous = sentences[best - 1];
  const next = sentences[best + 1];
  const quote = [
    named(previous) && !named(sentences[best]) ? previous : null,
    sentences[best],
    timed(next) ? next : null,
  ].filter(Boolean).join(' ');
  return quote.length > 420 ? `${quote.slice(0, 417)}…` : quote;
}

export function ruleCluster(cluster: WorldCluster, sources: ScoredSource[], quote: { url: string; text: string } | null): Ruling {
  const best = sources.find((source) => source.strong && quote && source.url === quote.url) || sources.find((source) => source.strong) || null;
  const names = cluster.employees.join(', ');
  const window = describeWindow(cluster.windowStart, cluster.windowEnd);
  if (!best) {
    return {
      verdict: 'no_outside_cause',
      headline: 'No outside cause found',
      detail: `Trace searched the public web and found nothing that explains these ${cluster.cases.length} cases together. Review them one at a time before contacting anyone.`,
      quote: null, sourceUrl: null,
      actions: cluster.cases.map((item) => `Keep ${item.groupId} (${item.merchant}, ${item.employee}) in the review queue`),
    };
  }
  if (cluster.signature === 'duplicate_settlement') {
    return {
      verdict: 'outside_event',
      headline: `Outside event: duplicate ${cluster.network || 'card'} settlements, ${window}`,
      detail: `${domain(best.url)} documents duplicate ${cluster.network || 'card'} charges${cluster.processor ? ` on ${cluster.processor} payments` : ''} in this window. All ${cluster.cases.length} extra postings (${names}) fall inside it, at ${cluster.cases.length} different merchants. This is a processing error, not employee error. No one needs to be contacted.`,
      quote: quote?.text ?? null,
      sourceUrl: quote?.url ?? best.url,
      actions: [
        ...cluster.cases.map((item) => `Draft dispute: duplicate ${cluster.network || 'card'} charge of ${money(item.amountCents, item.currency)} at ${item.merchant} (${item.groupId}). Reason: duplicate processing.`),
        `Clear ${cluster.employees.length} employees. Total to recover: ${money(cluster.totalCents, cluster.currency)}`,
      ],
    };
  }
  return {
    verdict: 'shared_mechanism',
    headline: `Shared cause: the tip is added after the card is authorized${cluster.processor ? ` (${cluster.processor})` : ''}`,
    detail: `${domain(best.url)} explains that the final card charge includes the tip added after authorization, so a receipt photographed at the table shows less. All ${cluster.cases.length} cases (${names}) fit: the company card paid the full amount and no one gained. This is a capture-process fix, not a conduct issue.`,
    quote: quote?.text ?? null,
    sourceUrl: quote?.url ?? best.url,
    actions: [
      `Correct ${cluster.cases.length} entries to the card amount (+${money(cluster.totalCents, cluster.currency)} in tips)`,
      'One process fix for everyone: photograph the signed copy with the tip, not the itemized receipt',
      'No employee contact needed',
    ],
  };
}

export async function runWorldResearch(
  cluster: WorldCluster,
  transport: ResearchTransport,
  onStep: (step: ResearchStep) => void = () => {},
): Promise<ResearchRun> {
  const startedAt = new Date().toISOString();
  const steps: ResearchStep[] = [];
  const log = (step: ResearchStep) => { steps.push(step); onStep(step); };

  log({ kind: 'plan', text: `Hypothesis: ${cluster.hypothesis.label}. ${cluster.hypothesis.queries.length} searches planned.` });
  let hits: SearchHit[] = [];
  try {
    hits = await transport.search(cluster.hypothesis.queries);
    log({ kind: 'search', text: `Bright Data search returned ${hits.length} public results for: ${cluster.hypothesis.queries.map((query) => `“${query}”`).join(', ')}.` });
  } catch (error) {
    log({ kind: 'error', text: `Search failed: ${error instanceof Error ? error.message : 'unknown error'}.` });
  }

  const sources = scoreSources(cluster, hits);
  const strongCount = sources.filter((source) => source.strong).length;
  log({ kind: 'score', text: strongCount
    ? `${strongCount} of ${sources.length} results match the ${cluster.signature === 'duplicate_settlement' ? 'event, network and dates' : 'mechanism'} in the snippet alone.`
    : `No snippet among ${sources.length} results states the cause outright; reading the most relevant pages.` });

  let quote: { url: string; text: string } | null = null;
  // Read primary sources, not social posts. A promising page that names the processor or
  // network is read in full; the page text, not the snippet, decides whether it matches.
  const readable = sources.filter((source) => !SOCIAL.test(domain(source.url)));
  // An incident page must name the network or processor; a mechanism explainer need not.
  const promising = readable.filter((source) => !source.strong
    && (cluster.hypothesis.kind === 'mechanism' || source.matched.processor || source.matched.network)
    && EVENT_TERMS[cluster.signature].some((pattern) => pattern.test(`${source.title} ${source.snippet}`)));
  const toRead = [...readable.filter((source) => source.strong), ...promising].slice(0, 3);
  if (toRead.length) {
    try {
      const pages = await transport.scrape(toRead.map((source) => source.url));
      for (const page of pages) {
        const text = extractQuote(cluster, page.text);
        if (!text) continue;
        quote = { url: page.url, text };
        const source = sources.find((item) => item.url === page.url || item.url.replace(/\/$/, '') === page.url.replace(/\/$/, ''));
        if (source && !source.strong) {
          source.strong = true;
          source.matched.event = true;
          source.score += 4;
        }
        break;
      }
      log({ kind: 'read', text: quote
        ? `Read ${pages.length} page${pages.length === 1 ? '' : 's'} through Bright Data. ${domain(quote.url)} contains the matching passage.`
        : `Read ${pages.length} page${pages.length === 1 ? '' : 's'} through Bright Data; none states the cause directly.` });
    } catch (error) {
      log({ kind: 'error', text: `Page read failed: ${error instanceof Error ? error.message : 'unknown error'}. Using the search snippet.` });
    }
  }
  sources.sort((a, b) => b.score - a.score);
  const firstStrong = sources.find((source) => source.strong);
  if (!quote && firstStrong) quote = { url: firstStrong.url, text: firstStrong.snippet };

  const ruling = ruleCluster(cluster, sources, quote);
  log({ kind: 'rule', text: ruling.headline });
  return { clusterId: cluster.id, mode: 'live', startedAt, finishedAt: new Date().toISOString(), steps, sources: sources.slice(0, 8), ruling };
}
