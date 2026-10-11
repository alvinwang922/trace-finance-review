import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Compass, CreditCard, FileCheck2, FileText, FolderOpen, Globe2, Layers3, ListFilter, Loader2, MapPin, MessageSquare, MoreHorizontal, Play, ReceiptText, Search, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { demoDataset } from './data/demo';
import { analyzeDataset } from './lib/engine';
import { parseCsvRecords } from './lib/csv';
import type { Dataset, RecordSource, ReviewCase, SourceRecord } from './lib/types';
import { draftCaseExplanation, isBase44Configured, loadDecisions, loginToBase44, persistDecision } from './lib/base44';
import { candidatesFromSerp, livePrice, menuPriceRange, placeFromSerp, serpAvailable, serpLookup } from './lib/serp';

type View = 'review' | 'records' | 'patterns' | 'inbox' | 'completed';
type Decision = { status: 'confirmed' | 'explained' | 'needs_information'; note: string; at: string };
type Decisions = Record<string, Decision>;
type ResponseAction = 'apply_evidence' | 'resolve' | 'reopen' | 'ticket';
type ResponseItem = { id: string; caseId: string; channel: 'email' | 'text'; from: string; receivedAt: string; body: string; attachment?: string; status: 'waiting' | 'new' | 'processed'; action?: ResponseAction };
type MerchantCandidate = { name: string; website: string; location: string; category: string; confidence: number; signals: string[] };
type PolicyPattern = { id: string; employee: string; caseIds: string[]; caseCount: number; differenceCount: number; missingCount: number; totalDifferenceCents: number; headline: string; detail: string };
type TourStep = { selector: string | null; title: string; text: string };
const TOUR_STEPS: TourStep[] = [
  { selector: '.sidebar nav', title: 'This is your menu', text: 'Everything lives here. "Items to check" is your to-do list — Records holds your documents, and replies come back to Replies.' },
  { selector: '.summary-grid', title: 'The quick picture', text: 'Three numbers before you start: how many items need you, how much money doesn\u2019t match yet, and how many documents are linked.' },
  { selector: '.case-list', title: 'Your to-do list', text: 'Each row is one item. The badge says in plain words what\u2019s going on — like "Amounts don\u2019t match" or "Missing paperwork". Click any row to open it.' },
  { selector: '.money-flow', title: 'Follow the money', text: 'Read left to right: what was submitted, what receipts show, and what the card was charged — plus refunds. Anything absent shows as "not provided".' },
  { selector: '.flow-verdict', title: 'The one-line answer', text: 'This line tells you whether the documents agree — or exactly how much is still unexplained.' },
  { selector: '.case-outreach', title: 'Ask, don\u2019t guess', text: 'If something\u2019s unclear, send the suggested question to the employee by email or text. Their reply lands in Replies.' },
  { selector: '.detail-actions', title: 'Make your call', text: 'When you\u2019ve seen enough, record your decision here. It documents your call — nothing touches your accounting records.' },
  { selector: null, title: 'That\u2019s the whole loop', text: 'Work down the list, ask where it\u2019s unclear, then save your decision. Replay this tour anytime — it\u2019s in the sidebar under "Take the tour".' },
];
const kindLabels: Record<string, string> = { amount_difference: "Amounts don't match", split_purchase: 'Split purchase — explained', missing_evidence: 'Missing paperwork', ambiguous: 'Needs a closer look', matched: 'Amounts agree' };
const sourceLabels: Record<string, string> = { expense: 'Expense submission', receipt: 'Receipt', card: 'Card charge', order: 'Purchase order', refund: 'Refund' };
const SOURCE_COLORS: Record<string, string> = { expense: '#55704a', card: '#44677a', receipt: '#ac8953', order: '#8a7fa6', refund: '#b0764f' };
const KIND_COLORS: Record<string, string> = { amount_difference: '#ac8953', missing_evidence: '#8e9aae', ambiguous: '#a18cac', matched: '#83a169', split_purchase: '#83a169' };
const LEG_LABELS: Record<string, string> = { expense: 'Submitted', receipt: 'Receipts', card: 'Card charged', refund: 'Refunds' };
function amountLegs(records: SourceRecord[]) {
  return (['expense', 'receipt', 'card', 'refund'] as RecordSource[]).map(source => {
    const rows = records.filter(r => r.source === source);
    return { source, label: LEG_LABELS[source], cents: rows.reduce((s, r) => s + r.amountCents, 0), first: rows[0] || null };
  });
}
const money = (cents: number | null, currency = 'USD') => cents === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD' }).format(cents / 100);
const recordDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function investigateCase(selected: ReviewCase, records: SourceRecord[], allCases: ReviewCase[]) {
  const gap = Math.abs(selected.differenceCents || 0);
  const comparison = selected.expectedCents || selected.actualCents || 0;
  const gapShare = comparison ? Math.round((gap / comparison) * 100) : 0;
  const sameEmployeeCases = allCases.filter(c => c.id !== selected.id && c.employee === selected.employee && attentionKind(c.kind));
  const hasReceipt = records.some(r => r.source === 'receipt');
  const hasCard = records.some(r => r.source === 'card');
  const hasExpense = records.some(r => r.source === 'expense');
  const signals = [
    gapShare >= 15 && gapShare <= 25 ? `The gap is ${gapShare}% of the comparison amount, a range worth checking for an omitted tip or fee.` : null,
    gap > 0 && gap % 900 === 0 ? 'The difference is divisible by 9. Check for a transposed or re-keyed amount before assuming intent.' : null,
    !hasReceipt ? 'No receipt is present in the supplied records, so the cause cannot be tested from source evidence yet.' : null,
    !hasCard ? 'No card charge is present in the supplied records, so settlement cannot be confirmed.' : null,
    !hasExpense ? 'No accounting expense entry is present in the supplied records.' : null,
  ].filter(Boolean) as string[];
  if (!signals.length) signals.push('No high-confidence pattern was found from the supplied values. Continue with the original source documents.');
  return {
    signals,
    recurring: sameEmployeeCases.length ? `${selected.employee} appears in ${sameEmployeeCases.length} other review case${sameEmployeeCases.length === 1 ? '' : 's'} across ${new Set(sameEmployeeCases.map(c => c.merchant)).size} merchant${new Set(sameEmployeeCases.map(c => c.merchant)).size === 1 ? '' : 's'}. Compare the cases for a repeatable process issue before escalating.` : `No other review case for ${selected.employee} was found in the current dataset.`,
    concern: selected.differenceCents ? `The records support a ${money(gap, selected.currency)} difference that needs an explanation before anyone is blamed.` : 'The records do not establish an unresolved amount difference.',
    innocent: hasReceipt && hasCard ? 'An innocent explanation remains possible: tip, tax, timing, refund, split charge, or a data-entry mistake.' : 'The supplied records are incomplete, so an innocent explanation cannot be ruled out.',
    question: selected.nextQuestion || `Your ${hasCard ? 'card charge' : 'accounting entry'} and ${hasReceipt ? 'receipt' : 'submitted amount'} do not line up. Could you confirm what the difference represents and share any updated evidence?`,
  };
}
function attentionKind(kind: string): boolean { return ['amount_difference', 'missing_evidence', 'ambiguous'].includes(kind); }
function localDraft(selected: ReviewCase, records: SourceRecord[]) {
  const citations = records.slice(0, 3).map(record => `[${record.id}]`).join(' ');
  return {
    explanation: `${selected.summary} This is a review aid based on the linked records, not a final accounting decision. ${citations}`.trim(),
    question: selected.nextQuestion,
  };
}
function download(name: string, content: string, type = 'text/plain') { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function readSaved<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function saveLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Session remains usable if the browser disallows storage. */ } }
function demoResponse(): ResponseItem[] {
  const first = analyzeDataset(demoDataset as Dataset).find(c => c.kind === 'amount_difference' || c.kind === 'missing_evidence');
  if (!first) return [];
  return [{ id: 'demo-response-1', caseId: first.id, channel: 'email', from: first.employee || 'employee@northstar.example', receivedAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(), body: 'I found the updated receipt. The original total missed the service fee, and the attached receipt shows the final amount.', attachment: 'updated-receipt.pdf', status: 'new' }];
}
function merchantCandidates(reviewCase: ReviewCase): MerchantCandidate[] {
  const base = reviewCase.merchant;
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [
    { name: base, website: `${slug}.com`, location: 'Name and transaction context match', category: 'Primary public business result', confidence: 94, signals: ['Exact merchant-name match', 'Public business listing found', 'Category is consistent with the transaction'] },
    { name: `${base} — Downtown location`, website: `${slug}.com/locations`, location: 'Possible location-level match', category: 'Local business listing', confidence: 68, signals: ['Name is similar', 'Location needs reviewer confirmation', 'Could be a separate branch'] },
    { name: `${base} Online`, website: `shop.${slug}.com`, location: 'Possible online merchant match', category: 'Online storefront', confidence: 36, signals: ['Name is similar', 'No location match in the current records', 'Keep separate unless receipt confirms it'] },
  ];
}
function priceContext(reviewCase: ReviewCase): { range: string; signal: string; note: string } {
  const amount = Math.abs(reviewCase.expectedCents || reviewCase.actualCents || 0);
  const low = Math.max(0, Math.round(amount * 0.8));
  const high = Math.round(amount * 1.25);
  return {
    range: `${money(low, reviewCase.currency)}–${money(high, reviewCase.currency)}`,
    signal: 'Needs public price context',
    note: `A production Bright Data lookup could compare this ${money(amount, reviewCase.currency)} charge with public menus, rate cards, or catalog examples. Public prices are directional evidence, not proof of overcharging.`,
  };
}
type FlowChip = { label: string; present: boolean; cents: number };
function moneyFlow(records: SourceRecord[]): FlowChip[] {
  const has = (source: RecordSource) => records.some((record) => record.source === source);
  const sum = (source: RecordSource) => records.filter((record) => record.source === source).reduce((acc, record) => acc + record.amountCents, 0);
  const refunds = sum('refund');
  const chips: FlowChip[] = [
    { label: 'Submitted', present: has('expense'), cents: sum('expense') },
    { label: 'Receipts', present: has('receipt'), cents: sum('receipt') - refunds },
    { label: 'Card charged', present: has('card'), cents: sum('card') - refunds },
  ];
  if (refunds > 0) chips.push({ label: 'Refunds', present: true, cents: refunds });
  return chips;
}
function flowVerdict(selected: ReviewCase): { tone: 'match' | 'mismatch' | 'review'; text: string } {
  if (selected.kind === 'amount_difference' && selected.differenceCents !== null) {
    return { tone: 'mismatch', text: `The ${money(Math.abs(selected.differenceCents), selected.currency)} difference isn't explained yet.` };
  }
  if (selected.kind === 'matched' || selected.kind === 'split_purchase') return { tone: 'match', text: 'Everything adds up — the documents agree.' };
  if (selected.kind === 'missing_evidence') return { tone: 'review', text: 'Some documents are missing, so the amounts cannot be fully compared.' };
  return { tone: 'review', text: 'Trace could not compare these safely — see the note below.' };
}
function detectPolicyPatterns(reviewCases: ReviewCase[]): PolicyPattern[] {
  const grouped = new Map<string, ReviewCase[]>();
  reviewCases.filter(reviewCase => ['amount_difference', 'missing_evidence', 'ambiguous'].includes(reviewCase.kind) && reviewCase.employee.trim()).forEach(reviewCase => {
    const employee = reviewCase.employee.trim();
    grouped.set(employee, [...(grouped.get(employee) || []), reviewCase]);
  });
  return [...grouped.entries()]
    .filter(([, employeeCases]) => employeeCases.length >= 2)
    .map(([employee, employeeCases]) => {
      const differenceCount = employeeCases.filter(reviewCase => reviewCase.kind === 'amount_difference').length;
      const missingCount = employeeCases.filter(reviewCase => reviewCase.kind === 'missing_evidence').length;
      const totalDifferenceCents = employeeCases.reduce((sum, reviewCase) => sum + Math.abs(reviewCase.differenceCents || 0), 0);
      const headline = differenceCount >= 2 ? 'Repeated amount differences' : missingCount >= 2 ? 'Repeated missing evidence' : 'Recurring evidence issue';
      const detail = `${employeeCases.length} cases need review. ${differenceCount ? `${differenceCount} amount ${differenceCount === 1 ? 'difference' : 'differences'}` : 'No confirmed amount difference'}${missingCount ? ` and ${missingCount} missing-evidence ${missingCount === 1 ? 'case' : 'cases'}` : ''}.`;
      return { id: employee.toLowerCase().replace(/[^a-z0-9]+/g, '-'), employee, caseIds: employeeCases.map(reviewCase => reviewCase.id), caseCount: employeeCases.length, differenceCount, missingCount, totalDifferenceCents, headline, detail };
    })
    .sort((a, b) => b.caseCount - a.caseCount || b.totalDifferenceCents - a.totalDifferenceCents);
}
function Badge({ kind, small = false }: { kind: string; small?: boolean }) { return <span className={`badge ${kind} ${small ? 'small' : ''}`}><span />{kindLabels[kind] || kind}</span>; }
function App() {
  const [dataset, setDataset] = useState<Dataset>(() => { const saved = readSaved<Dataset | null>('trace-dataset-v1', null); return saved && Array.isArray(saved.records) ? saved : demoDataset as Dataset; });
  const [decisions, setDecisions] = useState<Decisions>(() => readSaved('trace-decisions-v1', {}));
  const [responses, setResponses] = useState<ResponseItem[]>(() => readSaved<ResponseItem[]>('trace-responses-v1', demoResponse()));
  const [view, setView] = useState<View>('review');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('needs_review');
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [investigationOpen, setInvestigationOpen] = useState(false);
  const [merchantIdentityOpen, setMerchantIdentityOpen] = useState(false);
  const [merchantMatches, setMerchantMatches] = useState<Record<string, string>>(() => readSaved('trace-merchant-matches-v1', {}));
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [outreachChannel, setOutreachChannel] = useState<'email' | 'text'>('email');
  const [outreachRecipient, setOutreachRecipient] = useState('');
  const [selectedResponseId, setSelectedResponseId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string[]>([]);
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [toast, setToast] = useState('');
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [decisionStatus, setDecisionStatus] = useState<Decision['status']>('confirmed');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingCloud, setLoadingCloud] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<{ explanation: string; question: string | null } | null>(null);
  const [activeTab, setActiveTab] = useState<'evidence' | 'activity'>('evidence');
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [webLookupErrors, setWebLookupErrors] = useState<string[]>([]);
  const [webLookup, setWebLookup] = useState<{ status: 'idle' | 'loading' | 'live' | 'demo'; candidates: MerchantCandidate[]; candidatesLive: boolean; priceLive: boolean; priceRange: string; priceSignal: string; priceNote: string; place: string | null }>({ status: 'idle', candidates: [], candidatesLive: false, priceLive: false, priceRange: '', priceSignal: '', priceNote: '', place: null });
  const fileInput = useRef<HTMLInputElement>(null);
  const cases = useMemo(() => analyzeDataset(dataset), [dataset]);
  const keyFor = (c: ReviewCase) => `${dataset.id}:${c.id}`;
  const isReviewed = (c: ReviewCase) => ['confirmed', 'explained'].includes(decisions[keyFor(c)]?.status);
  const attention = (c: ReviewCase) => ['amount_difference', 'missing_evidence', 'ambiguous'].includes(c.kind);
  const openCases = cases.filter(c => attention(c) && !isReviewed(c));
  const reviewedCases = cases.filter(isReviewed);
  const policyPatterns = useMemo(() => detectPolicyPatterns(cases), [cases]);
  const filtered = cases.filter(c => {
    if (view === 'completed' && !isReviewed(c)) return false;
    if (view === 'review' && filter === 'needs_review' && (!attention(c) || isReviewed(c))) return false;
    if (view === 'review' && filter === 'explained' && !['matched', 'split_purchase'].includes(c.kind)) return false;
    return `${c.merchant} ${c.employee} ${c.groupId} ${c.title} ${kindLabels[c.kind]}`.toLowerCase().includes(search.toLowerCase());
  });
  const filteredRecords = dataset.records.filter(r => `${r.merchant} ${r.employee} ${r.groupId} ${r.id} ${r.source}`.toLowerCase().includes(search.toLowerCase()));
  const selected = filtered.find(c => c.id === selectedId) || filtered[0];
  const relatedRecords = selected ? dataset.records.filter(r => selected.recordIds.includes(r.id)) : [];
  const selectedDecision = selected ? decisions[keyFor(selected)] : undefined;
  const flowChips = selected ? moneyFlow(relatedRecords) : [];
  const verdict = selected ? flowVerdict(selected) : null;
  const barLegs = selected ? amountLegs(relatedRecords) : [];
  const barMax = Math.max(1, ...barLegs.map(l => l.cents));
  const docCounts = (['expense', 'card', 'receipt', 'order', 'refund'] as RecordSource[]).map(source => ({ source, n: dataset.records.filter(r => r.source === source).length })).filter(d => d.n > 0);
  const newResponses = responses.filter(response => response.status === 'new');
  const selectedResponse = responses.find(response => response.id === selectedResponseId);
  const activeResponse = selected ? (selectedResponse?.caseId === selected.id ? selectedResponse : responses.find(response => response.caseId === selected.id && response.status === 'new')) : undefined;
  const activeCaseRef = useRef('');
  activeCaseRef.current = selected ? `${dataset.id}:${selected.id}` : '';
  const activeDatasetRef = useRef({ id: dataset.id, version: 0 });
  if (activeDatasetRef.current.id !== dataset.id) {
    activeDatasetRef.current = { id: dataset.id, version: activeDatasetRef.current.version + 1 };
  }
  const cloudRequestRef = useRef(0);

  const discrepancies = cases.filter(c => c.kind === 'amount_difference' && c.differenceCents !== null);
  const currencies = [...new Set(discrepancies.map(c => c.currency))];
  const discrepancyAmount = discrepancies.reduce((sum, c) => sum + Math.abs(c.differenceCents || 0), 0);
  useEffect(() => saveLocal('trace-dataset-v1', dataset), [dataset]);
  useEffect(() => saveLocal('trace-decisions-v1', decisions), [decisions]);
  useEffect(() => saveLocal('trace-responses-v1', responses), [responses]);
  useEffect(() => saveLocal('trace-merchant-matches-v1', merchantMatches), [merchantMatches]);
  useEffect(() => { setAiResult(null); setActiveTab('evidence'); setCompareMode(false); setResolutionOpen(false); setInvestigationOpen(false); setMerchantIdentityOpen(false); setOutreachOpen(false); setOutreachRecipient(selected?.employee ? `${selected.employee.toLowerCase().replace(/\s+/g, '.')}@northstar.example` : ''); setNote(''); setWebLookup({ status: 'idle', candidates: [], candidatesLive: false, priceLive: false, priceRange: '', priceSignal: '', priceNote: '', place: null }); }, [selected?.id, dataset.id]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowImport(false); setShowHelp(false); setSource(null); setResolutionOpen(false); setInvestigationOpen(false); setMerchantIdentityOpen(false); setOutreachOpen(false); } }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
  useEffect(() => { if (readSaved<boolean>('trace-tour-seen-v1', false)) return; const t = setTimeout(() => setTourStep(0), 700); return () => clearTimeout(t); }, []);

  // When the merchant-identity modal opens, ask the local SERP proxy for public
  // context: statement-descriptor resolution, menu/product price range, and an
  // approximate map location. Falls back to demo data when unconfigured.
  useEffect(() => {
    if (!merchantIdentityOpen || !selected) return;
    let cancelled = false;
    const controller = new AbortController();
    setWebLookupErrors([]);
    const descriptor = (relatedRecords.find(record => record.source === 'card')?.merchant || selected.merchant).trim();
    const charge = Math.abs(selected.actualCents || selected.expectedCents || 0);
    const demoP = priceContext(selected);
    const demo = { priceRange: demoP.range, priceSignal: demoP.signal, priceNote: demoP.note, place: null as string | null };
    setWebLookup(prev => ({ ...prev, status: 'loading' }));
    void (async () => {
      if (!(await serpAvailable())) {
        if (!cancelled) {
          setWebLookupErrors(['Public lookups are not connected. Showing illustrative sample context.']);
          setWebLookup({ status: 'demo', candidates: merchantCandidates(selected), candidatesLive: false, priceLive: false, ...demo });
        }
        return;
      }
      setWebLookup({ status: 'loading', candidates: merchantCandidates(selected), candidatesLive: false, priceLive: false, ...demo });
      let anyLive = false;
      await Promise.all([
        { label: 'Merchant match', query: `${descriptor} ${selected.merchant} business`, type: 'search' as const },
        { label: 'Price comparison', query: `${selected.merchant} menu prices`, type: 'search' as const },
      ].map(async ({ label, query, type }) => {
        const { result, error } = await serpLookup(query, type, controller.signal);
        if (cancelled) return;
        if (error) setWebLookupErrors(previous => [...previous, `${label}: ${error}`]);
        if (!result) return;
        anyLive = true;
        setWebLookup(previous => {
          if (label === 'Merchant match' && result.organic.length) return { ...previous, candidates: candidatesFromSerp(result.organic, descriptor), candidatesLive: true, place: placeFromSerp(result) };
          if (label === 'Price comparison') {
            const range = selected.currency === 'USD' ? menuPriceRange(result.organic, result.aioText) : null;
            if (range) return { ...previous, priceLive: true, ...livePrice(range, charge, selected.currency) };
          }
          return previous;
        });
      }));
      if (!cancelled) setWebLookup(previous => ({ ...previous, status: anyLive ? 'live' : 'demo' }));
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [merchantIdentityOpen, selected, dataset.id]);

  function startTour() {
    setShowHelp(false); setShowImport(false); setSource(null); setResolutionOpen(false); setInvestigationOpen(false); setMerchantIdentityOpen(false); setOutreachOpen(false);
    setView('review'); setSearch(''); setFilter('all'); setSelectedId(null); setActiveTab('evidence');
    setTourStep(0);
  }
  function endTour() { setTourStep(null); saveLocal('trace-tour-seen-v1', true); }

  async function importFile(file?: File) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setImportError(['Please use a CSV smaller than 5 MB.']); return; }
    try {
      const text = await file.text();
      const parsed = parseCsvRecords(text, file.name);
      if (parsed.errors.length) { setImportError(parsed.errors); return; }
      if (!parsed.records.length) { setImportError(['This file contains no records.']); return; }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const datasetId = 'import-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      setDataset({ id: datasetId, name: file.name.replace(/\.csv$/i, '').replace(/[-_]/g, ' '), records: parsed.records, isDemo: false });
      setSelectedId(null); setView('review'); setFilter('all'); setSearch(''); setImportError([]); setShowImport(false);
      setToast(`Imported ${parsed.records.length} documents. Check the groupings before saving decisions.`);
    } catch { setImportError(['This file could not be read. Please try a UTF-8 CSV using the sample columns.']); }
    if (fileInput.current) fileInput.current.value = '';
  }
  async function saveDecision() {
    if (!selected || !note.trim()) return;
    setSaving(true);
    const decision: Decision = { status: decisionStatus, note: note.trim(), at: new Date().toISOString() };
    setDecisions(prev => ({ ...prev, [keyFor(selected)]: decision }));
    try {
      if (isBase44Configured) await persistDecision({ datasetId: dataset.id, caseId: selected.id, status: decisionStatus, note: decision.note });
      setToast(isBase44Configured ? 'Done — saved to your Base44 account and moved to Reviewed.' : 'Done — saved in this browser and moved to Reviewed.');
    } catch (error) { setToast(`Review saved locally. ${error instanceof Error ? error.message : 'Cloud save is unavailable.'}`); }
    setSaving(false); setResolutionOpen(false);
  }
  function recordOutreach() {
    if (!selected) return;
    const response: ResponseItem = {
      id: `outreach-${Date.now()}`,
      caseId: selected.id,
      channel: outreachChannel,
      from: outreachRecipient || 'recipient review',
      receivedAt: new Date().toISOString(),
      body: investigateCase(selected, relatedRecords, cases).question,
      status: 'waiting',
    };
    setResponses(previous => [response, ...previous]);
    setSelectedResponseId(response.id);
    setOutreachOpen(false);
    setView('inbox');
    setToast('Request queued — any reply will show up in Replies.');
  }
  function simulateResponse(response: ResponseItem) {
    const caseForResponse = cases.find(item => item.id === response.caseId);
    setResponses(previous => previous.map(item => item.id === response.id ? { ...item, status: 'new', body: caseForResponse?.kind === 'missing_evidence' ? 'I found the missing receipt and attached it here. Please use the final amount shown on the receipt.' : 'I checked this purchase. The difference is the service fee shown on the updated receipt.', attachment: 'updated-receipt.pdf', receivedAt: new Date().toISOString() } : item));
    setSelectedResponseId(response.id);
    setToast('A demo reply arrived in Replies.');
  }
  function processResponse(action: ResponseAction) {
    if (!selectedResponse) return;
    const caseForResponse = cases.find(item => item.id === selectedResponse.caseId);
    if (!caseForResponse) return;
    const key = `${dataset.id}:${caseForResponse.id}`;
    const noteForResponse = `Response received via ${selectedResponse.channel === 'email' ? 'email' : 'SMS'} from ${selectedResponse.from}: ${selectedResponse.body}${selectedResponse.attachment ? ` Attachment: ${selectedResponse.attachment}.` : ''}`;
    if (action === 'resolve' || action === 'apply_evidence') {
      const decision: Decision = { status: 'explained', note: noteForResponse, at: new Date().toISOString() };
      setDecisions(previous => ({ ...previous, [key]: decision }));
    } else if (action === 'reopen' || action === 'ticket') {
      const decision: Decision = { status: 'needs_information', note: action === 'ticket' ? `Follow-up ticket created from response. ${noteForResponse}` : `Response needs manual review. ${noteForResponse}`, at: new Date().toISOString() };
      setDecisions(previous => ({ ...previous, [key]: decision }));
    }
    setResponses(previous => previous.map(item => item.id === selectedResponse.id ? { ...item, status: 'processed', action } : item));
    setToast(action === 'resolve' ? 'Done — the item is explained and moved to Reviewed.' : action === 'apply_evidence' ? "Reply added to the item's notes." : action === 'ticket' ? 'Follow-up ticket created and linked to this item.' : 'Item sent back for another look.');
  }
  async function draftExplanation() {
    if (!selected) return;
    setAiBusy(true);
    const requestCase = activeCaseRef.current;
    try { const draft = await draftCaseExplanation(selected, relatedRecords); if (activeCaseRef.current === requestCase) setAiResult(draft); }
    catch (error) {
      if (error instanceof Error && /sign in|Base44/i.test(error.message)) {
        setAiResult(localDraft(selected, relatedRecords));
        setToast('Showing a local evidence draft. Connect Base44 for the hosted AI version.');
      } else setToast(error instanceof Error ? error.message : 'Could not generate an explanation.');
    }
    finally { setAiBusy(false); }
  }
  async function restoreCloudReviews() {
    if (!isBase44Configured || loadingCloud) return;
    const requestedDataset = activeDatasetRef.current;
    const requestId = ++cloudRequestRef.current;
    const currentCaseIds = new Set(cases.map(reviewCase => reviewCase.id));
    const isCurrentRequest = () => cloudRequestRef.current === requestId
      && activeDatasetRef.current === requestedDataset;
    setLoadingCloud(true);
    try {
      const saved = await loadDecisions(requestedDataset.id);
      if (!isCurrentRequest()) return;
      const newestByCase = new Map<string, Decision>();
      for (const review of saved) {
        if (!currentCaseIds.has(review.caseId)
          || !['confirmed', 'explained', 'needs_information'].includes(review.status)
          || !Number.isFinite(Date.parse(review.at))) continue;
        const existing = newestByCase.get(review.caseId);
        if (!existing || Date.parse(review.at) > Date.parse(existing.at)) {
          newestByCase.set(review.caseId, {
            status: review.status as Decision['status'], note: review.note, at: review.at,
          });
        }
      }
      setDecisions(previous => {
        if (!isCurrentRequest()) return previous;
        const next = { ...previous };
        for (const [caseId, review] of newestByCase) {
          const key = `${requestedDataset.id}:${caseId}`;
          const local = previous[key];
          // A review saved while the request was running must not be replaced by an older event.
          if (local && Number.isFinite(Date.parse(local.at))
            && Date.parse(local.at) >= Date.parse(review.at)) continue;
          next[key] = review;
        }
        return next;
      });
      setToast(newestByCase.size
        ? `Checked cloud reviews for ${newestByCase.size} ${newestByCase.size === 1 ? 'case' : 'cases'}. Newer local reviews were kept.`
        : 'No cloud reviews match the cases in this dataset. Your local reviews are unchanged.');
    } catch (error) {
      if (isCurrentRequest()) setToast(error instanceof Error ? error.message : 'Cloud reviews could not be loaded.');
    } finally {
      if (cloudRequestRef.current === requestId) setLoadingCloud(false);
    }
  }
  function exportCase() {
    if (!selected) return;
    const text = [ 'TRACE · EXPENSE REVIEW', dataset.isDemo ? 'Fictional demonstration data' : `Dataset: ${dataset.name}`, `Case: ${selected.groupId} · ${selected.merchant}`, `Reviewer status: ${selectedDecision?.status || 'Not reviewed'}`, '', 'FINDING', selected.summary, '', 'EVIDENCE', ...selected.evidence.map(e => `• ${e}`), '', 'SOURCE RECORDS', ...relatedRecords.map(r => `${r.id} | ${sourceLabels[r.source]} | ${r.date} | ${money(r.amountCents, r.currency)} | ${r.description} | ${r.reference || 'No reference'}`), '', 'REVIEWER NOTE', selectedDecision?.note || 'No reviewer decision recorded.', '', 'OPEN QUESTION', selected.nextQuestion || 'No additional question generated.', '', 'This report records a review. It does not change accounting records or establish fraud.' ].join('\n');
    download(`trace-${selected.groupId}-review.txt`, text); setToast('Evidence report downloaded.');
  }
  function loadDemo() { setDataset(demoDataset as Dataset); setSelectedId(null); setView('review'); setFilter('needs_review'); setSearch(''); setToast('Fictional Northstar Studio dataset loaded.'); }

  const webReady = webLookup.status !== 'idle';
  const shownCandidates = webReady ? webLookup.candidates : (selected ? merchantCandidates(selected) : []);
  const shownPrice = webReady ? { range: webLookup.priceRange, signal: webLookup.priceSignal, note: webLookup.priceNote } : (selected ? priceContext(selected) : { range: '', signal: '', note: '' });
  const priceSourceTag = webLookup.priceLive ? 'Bright Data SERP · live public results' : 'Illustrative sample benchmark';
  const candidateSourceTag = webLookup.candidatesLive ? 'Bright Data SERP · live result' : 'Illustrative sample candidate';

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView('review'); }} aria-label="Trace home"><span className="brand-mark"><span /><span /><span /></span>trace<span className="brand-period">.</span></a>
      <div className="workspace-switch"><div className="workspace-icon">N</div><div><strong>{dataset.isDemo ? 'Northstar Studio' : 'Your workspace'}</strong><span>{dataset.isDemo ? 'Demo workspace' : 'Expense review'}</span></div><ChevronDown size={14} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={view === 'review' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('review'); setSearch(''); }}><Layers3 size={18} />Items to check<span className="nav-count">{openCases.length}</span></button>
        <button className={view === 'records' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('records'); setSearch(''); }}><FolderOpen size={18} />Records</button>
        <button className={view === 'patterns' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('patterns'); setSearch(''); setSelectedId(policyPatterns[0]?.caseIds[0] || null); }}><ShieldCheck size={18} />Repeat patterns<span className="nav-count">{policyPatterns.length}</span></button>
        <button className={view === 'inbox' ? 'nav-item active' : 'nav-item'} onClick={() => { const nextResponse = newResponses[0] || responses[0]; setView('inbox'); setSearch(''); setSelectedResponseId(nextResponse?.id || null); if (nextResponse) setSelectedId(nextResponse.caseId); }}><MessageSquare size={18} />Replies<span className="nav-count">{newResponses.length}</span></button>
        <button className={view === 'completed' ? 'nav-item active' : 'nav-item'} onClick={() => { setView('completed'); setSearch(''); }}><CheckCheck size={18} />Reviewed<span className="quiet-count">{reviewedCases.length}</span></button>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={20} /><strong>Every finding has a source.</strong><p>Follow the evidence. Keep the final decision yours.</p></div><button className="nav-item" onClick={startTour}><Compass size={18} />Take the tour<ArrowUpRight size={14} /></button><button className="nav-item" onClick={() => setShowHelp(true)}><CircleHelp size={18} />How Trace works<ArrowUpRight size={14} /></button><div className="profile"><span>Y</span><div><strong>Your workspace</strong><small>{isBase44Configured ? 'Base44 configured' : 'Local preview'}</small></div><span className={`connection-dot ${isBase44Configured ? 'connected' : ''}`} /></div></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={13} /><span>{view === 'review' ? 'Items to check' : view === 'records' ? 'Records' : view === 'patterns' ? 'Repeat patterns' : view === 'inbox' ? 'Replies' : 'Reviewed items'}</span></div><div className="topbar-right">{isBase44Configured && <button className="button secondary" onClick={restoreCloudReviews} disabled={loadingCloud} title="Load your latest saved Base44 reviews for this dataset. Newer local reviews are kept.">{loadingCloud ? <Loader2 className="spin" size={15} /> : <ArrowDownToLine size={15} />}{loadingCloud ? 'Loading reviews…' : 'Load cloud reviews'}</button>}{dataset.isDemo && <span className="demo-pill"><span />SAMPLE DATA</span>}<button className="icon-button" aria-label="About this workspace" onClick={() => setShowHelp(true)}><CircleHelp size={19} /></button></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">EXPENSE OPERATIONS</div><h1>{view === 'records' ? 'Connect the paper trail.' : view === 'completed' ? 'Reviewed. Documented.' : view === 'patterns' ? 'Find repeat patterns early.' : view === 'inbox' ? 'Turn replies into action.' : 'Make sense of the difference.'}</h1><p>{view === 'records' ? 'Add your accounting entries, card charges, and receipts here first.' : view === 'completed' ? 'Your decisions, with the documents that back them up.' : view === 'patterns' ? 'Spot employees or vendors with repeated issues before they grow.' : view === 'inbox' ? 'Replies land on the right item so you can act on them.' : 'Pick an item to see what happened, why it might be fine, and what to do next.'}</p></div><button className="button primary" onClick={() => { setImportError([]); setShowImport(true); }}><Upload size={16} />Import documents</button></div>
        <div className="summary-grid"><div className="summary-card"><div className="summary-icon amber"><ClipboardList size={19} /></div><div><span>Items to check</span><strong>{openCases.length}<small>items</small></strong></div><div className="mini-bars"><i /><i /><i /><i /><i /></div></div><div className="summary-card"><div className="summary-icon coral"><ReceiptText size={19} /></div><div><span>Amounts that don't match</span><strong>{currencies.length > 1 ? 'Multiple currencies' : money(discrepancyAmount, currencies[0] || 'USD')}</strong><small className="stat-note">Differences to check — not confirmed losses</small></div></div><div className="summary-card"><div className="summary-icon green"><FileCheck2 size={19} /></div><div><span>Documents linked</span><strong>{dataset.records.length}<small>documents</small></strong></div><div className="source-stack"><FileText size={18} /><CreditCard size={18} /><ReceiptText size={18} /></div></div></div>
        <div className="dataset-strip"><span><span className="dataset-dot" />{dataset.name}</span><div>{dataset.isDemo ? 'Fictional records · Safe to explore' : `${cases.length} purchases · grouped by your IDs`}<button onClick={() => { if (dataset.isDemo) { const a = document.createElement('a'); a.href = '/demo/northstar-studio-september-2026.csv'; a.download = 'northstar-studio-september-2026.csv'; a.click(); } else loadDemo(); }} className="text-button">{dataset.isDemo ? 'Sample CSV' : 'Use sample data'}<ArrowUpRight size={13} /></button></div></div>

        <div className={`review-layout ${view === 'records' ? 'records-layout' : ''}`}>
          <section className="queue-panel">
            <div className="queue-heading"><h2>{view === 'records' ? 'Your documents' : view === 'completed' ? 'Reviewed items' : view === 'patterns' ? 'Repeat patterns' : view === 'inbox' ? 'Replies' : 'Items to check'}<span>{view === 'records' ? filteredRecords.length : view === 'patterns' ? policyPatterns.length : view === 'inbox' ? responses.length : filtered.length}</span></h2><button className="icon-button" aria-label="Help with this view" onClick={() => setShowHelp(true)}><MoreHorizontal size={18} /></button></div>
            <div className="queue-toolbar"><label className="search-field"><Search size={16} /><input placeholder={view === 'records' ? 'Search documents…' : 'Search merchant or employee…'} value={search} onChange={e => setSearch(e.target.value)} aria-label="Search records and cases" />{search && <button className="icon-button" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}</label>{view === 'review' && <label className="filter-select"><ListFilter size={15} /><select aria-label="Filter cases" value={filter} onChange={e => setFilter(e.target.value)}><option value="needs_review">Needs your review</option><option value="all">All items</option><option value="explained">Amounts agree</option></select></label>}</div>
            {view === 'records' ? <><div className="source-connect-grid"><button className="source-connect-card" onClick={() => { setImportError([]); setShowImport(true); }}><span className="source-connect-icon"><Upload size={18} /></span><span><strong>Import source files</strong><small>Accounting, card, receipt, or refund CSV</small></span><ArrowRight size={16} /></button><button className="source-connect-card future" onClick={() => setToast('QuickBooks Online connection is planned as a read-only source for entries, categories, dates, and references.')}><span className="source-connect-icon"><FileText size={18} /></span><span><strong>QuickBooks Online</strong><small>Entries, categories, dates, references</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('Chase company-card connection is planned as a read-only source for charges, refunds, dates, currency, and account references.')}><span className="source-connect-icon"><CreditCard size={18} /></span><span><strong>Chase company card</strong><small>Charges, refunds, dates, currency</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('Ramp and Gmail receipt access are planned only for authorized receipt evidence.')}><span className="source-connect-icon"><ReceiptText size={18} /></span><span><strong>Ramp / Gmail receipts</strong><small>Authorized receipt evidence and attachments</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('Email response sync is demo-connected. Production would use Gmail or Microsoft Graph webhooks.')}><span className="source-connect-icon"><MessageSquare size={18} /></span><span><strong>Email response sync</strong><small>Gmail / Microsoft 365 replies mapped to cases</small></span><span className="coming-soon">Demo connected</span></button><button className="source-connect-card future" onClick={() => setToast('SMS response sync is demo-connected. Production would use Twilio or Telnyx webhooks.')}><span className="source-connect-icon"><MessageSquare size={18} /></span><span><strong>SMS response sync</strong><small>Twilio / Telnyx replies and attachments</small></span><span className="coming-soon">Demo connected</span></button><button className="source-connect-card future" onClick={() => setToast('Xero connection is planned as a read-only accounting source.')}><span className="source-connect-icon"><FileText size={18} /></span><span><strong>Xero</strong><small>Ledger entries and attachments</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('NetSuite connection is planned as a read-only accounting source.')}><span className="source-connect-icon"><Layers3 size={18} /></span><span><strong>NetSuite</strong><small>Transactions and account references</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('Sage Intacct connection is planned as a read-only accounting source.')}><span className="source-connect-icon"><FileText size={18} /></span><span><strong>Sage Intacct</strong><small>Cash, ledger, and reconciliation data</small></span><span className="coming-soon">Planned</span></button><button className="source-connect-card future" onClick={() => setToast('Brex and Stripe connections are planned as read-only payment sources.')}><span className="source-connect-icon"><CreditCard size={18} /></span><span><strong>Brex / Stripe</strong><small>Cards, payments, refunds, metadata</small></span><span className="coming-soon">Planned</span></button></div><div className="records-table-wrap"><table className="records-table"><thead><tr><th>Record</th><th>Type</th><th>Merchant</th><th>Date</th><th>Amount</th><th /></tr></thead><tbody>{filteredRecords.map(r => <tr key={r.id} onClick={() => setSource(r)}><td><FileText size={15} />{r.id}<small>{r.groupId}</small></td><td>{sourceLabels[r.source]}</td><td>{r.merchant}</td><td>{recordDate(r.date)}</td><td>{r.source === 'refund' ? '−' : ''}{money(r.amountCents, r.currency)}</td><td><ArrowUpRight size={15} /></td></tr>)}</tbody></table>{!filteredRecords.length && <Empty title="No documents found" subtitle="Try another merchant, employee, or group ID." />}</div></> : view === 'patterns' ? <><div className="pattern-intro"><ShieldCheck size={18} /><div><strong>Pattern signals, not accusations</strong><p>Trace groups repeated document issues so you can understand the cause before escalating. A pattern never changes an employee record or accounting entry automatically.</p></div></div><div className="pattern-list">{policyPatterns.map(pattern => <button className="pattern-card" key={pattern.id} onClick={() => { setSelectedId(pattern.caseIds[0]); setView('review'); setFilter('all'); }}><div className="pattern-card-icon"><ShieldCheck size={17} /></div><div className="pattern-card-main"><strong>{pattern.employee}</strong><span>{pattern.headline}</span><p>{pattern.detail}</p><small>{pattern.totalDifferenceCents ? `${money(pattern.totalDifferenceCents, 'USD')} total amount difference · ` : ''}{pattern.caseIds.length} linked items · Open the first one</small></div><ChevronRight size={16} /></button>)}</div>{!policyPatterns.length && <Empty title="No repeat patterns yet" subtitle="Patterns show up when the same employee has repeated document issues." />}</> : view === 'inbox' ? <><div className="response-inbox-intro"><MessageSquare size={18} /><div><strong>One thread per item</strong><p>Replies stay attached to the item that generated the request. Demo replies can be simulated; production connectors would receive webhooks.</p></div></div><div className="response-list">{responses.map(response => { const responseCase = cases.find(item => item.id === response.caseId); return <button className={`response-row ${selectedResponseId === response.id ? 'selected' : ''}`} key={response.id} onClick={() => { setSelectedResponseId(response.id); if (responseCase) setSelectedId(responseCase.id); if (response.status === 'waiting') simulateResponse(response); }}><span className={`response-channel ${response.channel}`}><MessageSquare size={15} /></span><div><strong>{response.from}</strong><span>{response.channel === 'email' ? 'Email' : 'SMS'} · {response.status === 'waiting' ? 'Waiting for reply · click to simulate' : response.status === 'new' ? 'New reply' : 'Processed'}</span><p>{response.body}</p></div><ChevronRight size={15} /></button>; })}</div>{!responses.length && <Empty title="No responses yet" subtitle="Ask a question from any item to start a thread." />}</> : <>
              {view === 'review' && cases.length > 0 && <div className="glance-strip"><div className="glance-donut-wrap"><KindDonut cases={cases} /><div><strong>{openCases.length} to check</strong><span>{reviewedCases.length} reviewed · {cases.length} total</span></div></div><div className="glance-docs"><span className="glance-caption">YOUR DOCUMENTS</span><div className="doc-bar">{docCounts.map(d => <i key={d.source} style={{ flex: d.n, background: SOURCE_COLORS[d.source] }} title={`${d.n} ${sourceLabels[d.source].toLowerCase()}${d.n === 1 ? '' : 's'}`} />)}</div><div className="doc-legend">{docCounts.map(d => <button key={d.source} onClick={() => { setView('records'); setSearch(d.source); }} title={`Show ${sourceLabels[d.source].toLowerCase()} documents`}><i style={{ background: SOURCE_COLORS[d.source] }} />{d.n} {sourceLabels[d.source].toLowerCase()}{d.n === 1 ? '' : 's'}</button>)}</div></div></div>}
              <div className="list-columns"><span>MERCHANT / EMPLOYEE</span><span>FINDING</span></div>
              <div className="case-list">{filtered.map(c => <button className={`case-row ${selected?.id === c.id ? 'selected' : ''}`} key={c.id} onClick={() => setSelectedId(c.id)}><div className={`merchant-icon ${c.kind}`}><span>{c.merchant.split(' ').slice(0, 2).map(s => s[0]).join('')}</span></div><div className="case-main"><strong>{c.merchant}</strong><span>{c.employee || 'No employee specified'}<i />{c.groupId}</span><div className="case-meta"><FileText size={12} />{c.recordIds.length} documents{isReviewed(c) && <span className="reviewed-label"><Check size={11} />Reviewed</span>}</div></div><div className="case-finding"><Badge kind={c.kind} small /><strong className={c.kind === 'amount_difference' ? 'difference-value' : 'neutral-value'}>{c.kind === 'amount_difference' ? `${(c.differenceCents || 0) > 0 ? '+' : ''}${money(c.differenceCents, c.currency)}` : c.kind === 'matched' || c.kind === 'split_purchase' ? money(c.expectedCents, c.currency) : 'Evidence needed'}</strong></div><ChevronRight className="row-arrow" size={15} /></button>)}</div>
              {!filtered.length && <Empty title={view === 'completed' ? 'Your decisions will live here.' : 'Nothing in this view.'} subtitle={view === 'completed' ? 'Open an item, look at the documents, and save your decision.' : 'Try another filter or search to see more items.'} />}
              <div className="queue-footer"><ShieldCheck size={14} />No changes are made to your accounting records.</div>
            </>}
          </section>
          {view !== 'records' && selected && <section className="detail-panel" aria-label="Selected case details">
            <div className="detail-header"><div className="detail-label"><span>ITEM {filtered.indexOf(selected) + 1} OF {filtered.length} · {selected.groupId}</span><button className="icon-button" aria-label="Export this case" onClick={exportCase}><ArrowDownToLine size={16} /></button></div><h2>{selected.merchant}</h2><div className="detail-byline">{selected.employee}<span>·</span>{relatedRecords.length} documents</div><Badge kind={selected.kind} /></div>
            <div className="detail-tabs"><button className={activeTab === 'evidence' ? 'active' : ''} onClick={() => setActiveTab('evidence')}>What happened</button><button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>Your notes{selectedDecision && <span className="tab-dot" />}</button></div>
            <div className="detail-content">{activeResponse && <div className={`response-banner ${activeResponse.status}`}><div className="response-banner-heading"><span className={`response-channel ${activeResponse.channel}`}><MessageSquare size={14} /></span><div><strong>{activeResponse.status === 'waiting' ? 'Awaiting a reply' : activeResponse.status === 'processed' ? 'Reply handled' : 'New reply'}</strong><small>{activeResponse.channel === 'email' ? 'Email' : 'SMS'} · {activeResponse.from}</small></div></div><p>{activeResponse.body}</p>{activeResponse.attachment && <span className="response-attachment"><FileText size={13} />{activeResponse.attachment}</span>}{activeResponse.status === 'waiting' ? <button className="button secondary" onClick={() => simulateResponse(activeResponse)}>Simulate a reply</button> : activeResponse.status === 'new' ? <div className="response-actions"><button className="button secondary" onClick={() => processResponse('apply_evidence')}><Check size={14} />Add to the evidence</button><button className="button secondary" onClick={() => processResponse('ticket')}><ClipboardList size={14} />Create a follow-up ticket</button><button className="button primary" onClick={() => processResponse('resolve')}><CheckCheck size={14} />Mark as explained</button><button className="text-button" onClick={() => processResponse('reopen')}>Send back for another look</button></div> : <span className="response-processed">Saved in this item's notes.</span>}</div>}
              {activeTab === 'evidence' ? <>
              <div className="step-label"><b>1</b>What happened</div>
              <div className="money-flow">{flowChips.map((chip, index) => [index > 0 ? <ArrowRight key={`arrow-${index}`} className="flow-arrow" size={13} /> : null, <span key={chip.label} className={`flow-chip${chip.present ? '' : ' missing'}${chip.label === 'Refunds' ? ' refund' : ''}`}><small>{chip.label}</small><strong>{chip.present ? `${chip.label === 'Refunds' ? '−' : ''}${money(chip.cents, selected.currency)}` : 'not provided'}</strong></span>])}</div>
              <div className="amount-bars">{barLegs.map(leg => <button key={leg.source} type="button" className={`amount-bar${leg.first ? '' : ' missing'}`} onClick={() => leg.first && setSource(leg.first)} disabled={!leg.first} title={leg.first ? `Open the ${sourceLabels[leg.source].toLowerCase()}` : 'Not provided'}><span>{leg.label}</span><span className="amount-bar-track"><i style={{ width: leg.first ? `${Math.max(6, (leg.cents / barMax) * 100)}%` : 0, background: SOURCE_COLORS[leg.source] }} /></span><strong>{leg.first ? money(leg.cents, selected.currency) : 'none'}</strong></button>)}</div>
              {verdict && <div className={`flow-verdict ${verdict.tone}`}>{verdict.text}</div>}
              <div className="automated-summary"><div><Sparkles size={15} /><strong>In plain terms</strong><span>Calculated from your documents</span></div><p>{selected.summary}</p><small>Written automatically from your documents — a starting point, not a final decision.</small></div>
              <div className="step-label"><b>2</b>Why it might still be fine</div>
              <p className="step-text">{investigateCase(selected, relatedRecords, cases).innocent}</p>
              <div className="step-label"><b>3</b>What to do next</div>
              {selected.nextQuestion ? <div className="question-box"><div><MessageSquare size={15} /><strong>Ask this to move forward</strong></div><p>{selected.nextQuestion}</p><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(selected.nextQuestion!); setToast('Question copied. Nothing has been sent.'); } catch { setToast('Select and copy the question text above.'); } }}>Copy question<ArrowUpRight size={12} /></button></div> : <p className="step-text">Nothing left to ask — check the paper trail below, then record your decision.</p>}
              <div className="outreach-actions case-outreach"><strong>Ask the employee</strong><p>Send this question to the employee — pick a verified contact first.</p><div><button className="button secondary" onClick={() => { setOutreachChannel('email'); setOutreachOpen(true); }}><MessageSquare size={15} />Send email</button><button className="button secondary" onClick={() => { setOutreachChannel('text'); setOutreachOpen(true); }}><MessageSquare size={15} />Send text</button></div></div>
              <div className="section-label">THE PAPER TRAIL<span className="paper-tools"><b>{relatedRecords.length} documents</b><button type="button" className={compareMode ? 'view-toggle' : 'view-toggle on'} onClick={() => setCompareMode(false)}>List</button><button type="button" className={compareMode ? 'view-toggle on' : 'view-toggle'} onClick={() => setCompareMode(true)}>Compare</button></span></div>
              {relatedRecords.length > 1 && <TrailTimeline records={relatedRecords} onOpen={setSource} />}
              {compareMode ? <div className="compare-wrap"><table className="compare-table"><thead><tr><th />{relatedRecords.map(r => <th key={r.id}><i style={{ background: SOURCE_COLORS[r.source] }} />{sourceLabels[r.source]}<small>{recordDate(r.date)}</small></th>)}</tr></thead><tbody><tr><th>Amount</th>{relatedRecords.map(r => <td key={r.id} className={r.source === 'order' || r.source === 'refund' ? 'context' : selected.expectedCents !== null && r.amountCents !== selected.expectedCents ? 'mismatch' : ''}>{r.source === 'refund' ? '−' : ''}{money(r.amountCents, r.currency)}</td>)}</tr><tr><th>Date</th>{relatedRecords.map(r => <td key={r.id}>{recordDate(r.date)}</td>)}</tr><tr><th>Reference</th>{relatedRecords.map(r => <td key={r.id}>{r.reference || '—'}</td>)}</tr><tr><th>Description</th>{relatedRecords.map(r => <td key={r.id} className="compare-desc">{r.description || '—'}</td>)}</tr><tr><th>File</th>{relatedRecords.map(r => <td key={r.id} className="compare-file">{r.fileName}</td>)}</tr><tr><th />{relatedRecords.map(r => <td key={r.id}><button className="text-button" onClick={() => setSource(r)}>Open<ArrowUpRight size={11} /></button></td>)}</tr></tbody></table></div> : <div className="evidence-list">{relatedRecords.map((r, i) => <button className="evidence-item" key={r.id} onClick={() => setSource(r)}><span className="evidence-number">{String(i + 1).padStart(2, '0')}</span><div><strong>{sourceLabels[r.source]}</strong><span>{r.reference || r.id}<i />{recordDate(r.date)}</span></div><strong className={r.source === 'refund' ? 'refund-value' : ''}>{r.source === 'refund' ? '−' : ''}{money(r.amountCents, r.currency)}</strong><ArrowUpRight size={13} /></button>)}</div>}
              {selected.differenceCents !== null && <div className="difference-total"><span>{selected.kind === 'amount_difference' ? 'Unexplained difference' : 'Difference after comparison'}</span><strong>{money(Math.abs(selected.differenceCents), selected.currency)}</strong></div>}
              <div className="evidence-notes">{selected.evidence.filter(e => !/^(expense|receipt|card|order|refund):/.test(e)).map((e, i) => <p key={i}><Check size={13} />{e}</p>)}</div>
              <div className="section-label">MORE TOOLS<span>optional</span></div>
              <div className="merchant-identity-card"><div className="merchant-identity-icon"><Building2 size={16} /></div><div><strong>{merchantMatches[selected.id] || 'Who is this merchant?'}</strong><span>{merchantMatches[selected.id] ? 'Saved for matching next time' : "Match the card's short name to a real business so the numbers make sense."}</span></div><button className="button secondary" onClick={() => setMerchantIdentityOpen(true)}><Globe2 size={14} />{merchantMatches[selected.id] ? 'Review match' : 'Match merchant'}</button></div>
              <div className="trace-insight"><div><Sparkles size={14} /><strong>Worth a look</strong><span>Hint only — nothing changes</span></div><p>{investigateCase(selected, relatedRecords, cases).signals[0]}</p><button className="text-button" onClick={() => setInvestigationOpen(true)}>See the full breakdown<ArrowRight size={12} /></button></div>
              {aiResult && <div className="ai-result"><div><Sparkles size={16} /><strong>AI draft · Check against the evidence</strong><button className="icon-button ai-dismiss" aria-label="Dismiss this draft" onClick={() => setAiResult(null)}><X size={13} /></button></div><p>{aiResult.explanation.split(/(\[[^\]]+\])/g).map((part, i) => { const id = part.match(/^\[(.+)\]$/)?.[1]; const rec = id ? dataset.records.find(r => r.id === id) : undefined; return rec ? <button key={i} type="button" className="cite-chip" onClick={() => setSource(rec)} title={`Open ${sourceLabels[rec.source].toLowerCase()} · ${rec.id}`}>{rec.id}</button> : part; })}</p>{aiResult.question && <p><strong>Suggested question:</strong> {aiResult.question}</p>}<small className="ai-scope"><ShieldCheck size={11} />Only this item's documents were used to write this — nothing else left your workspace.</small></div>}
              <button className="button ai-button" onClick={draftExplanation} disabled={aiBusy} title="Draft an evidence-based explanation from this case">{aiBusy ? <Loader2 className="spin" size={15} /> : <Sparkles size={15} />}{aiBusy ? 'Drafting from the evidence…' : 'Write a draft explanation'}<span>{isBase44Configured ? "Only this item's documents are sent to Base44" : "Only this item's documents are used"}</span></button>
            </> : <div className="activity-panel"><div className="activity-event"><span className="activity-dot" /><div><strong>Documents compared</strong><p>{relatedRecords.length} documents grouped under {selected.groupId}. Amounts calculated from your documents.</p></div></div>{selectedDecision ? <div className="activity-event"><span className="activity-dot reviewed" /><div><strong>{selectedDecision.status === 'needs_information' ? 'More information requested' : 'Review saved'}</strong><small>{new Date(selectedDecision.at).toLocaleString()}</small><p>{selectedDecision.note}</p></div></div> : <div className="activity-empty"><ClipboardList size={25} /><p>No review saved yet.</p><span>Your note and decision will appear here.</span></div>}</div>}</div>
            <div className="detail-actions"><button className="button secondary" onClick={() => setInvestigationOpen(true)}><Sparkles size={15} />Check other explanations</button><button className="button secondary" onClick={exportCase}><ArrowDownToLine size={15} />Export report</button><button className="button primary" onClick={() => { setNote(selectedDecision?.note || ''); setDecisionStatus(selected.kind === 'matched' || selected.kind === 'split_purchase' ? 'explained' : selected.kind === 'amount_difference' ? 'confirmed' : 'needs_information'); setResolutionOpen(true); }}><Check size={16} />{selectedDecision ? 'Update your decision' : 'Record your decision'}<ArrowRight size={15} /></button></div>
          </section>}
        </div>
        <footer className="page-footer"><span>Clarity, one case at a time.</span><span>{dataset.isDemo ? 'Sample data is fictional.' : 'Imported records stay in this browser until you choose an AI or cloud action.'}</span></footer>
      </main>
    </div>
    {tourStep !== null && <TourOverlay index={tourStep} total={TOUR_STEPS.length} step={TOUR_STEPS[tourStep]} onBack={() => setTourStep(tourStep - 1)} onNext={() => tourStep === TOUR_STEPS.length - 1 ? endTour() : setTourStep(tourStep + 1)} onSkip={endTour} />}
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {showImport && <Modal title="Bring your records together" subtitle="Start with a CSV export. Your existing records stay untouched." onClose={() => setShowImport(false)}><div className="upload-zone" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void importFile(e.dataTransfer.files[0]); }}><span className="upload-icon"><Upload size={25} /></span><h3>Drop a CSV here</h3><p>Or choose a file from your computer. Up to 5 MB.</p><button className="button primary" onClick={() => fileInput.current?.click()}>Choose CSV file<ArrowRight size={15} /></button><input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={e => void importFile(e.target.files?.[0])} /></div>{importError.length > 0 && <div className="import-errors" role="alert"><strong>Let’s fix the file first</strong>{importError.slice(0, 8).map((e, i) => <p key={i}>{e}</p>)}{importError.length > 8 && <p>And {importError.length - 8} more errors.</p>}</div>}<div className="import-format"><h4>A small, consistent format</h4><p>Include a case ID (<code>groupId</code>) linking related rows, a source type, date, merchant, amount, and currency. Source types: expense, card, receipt, order, refund. Use positive amounts for refunds; Trace subtracts them.</p><p>The first version compares exported record data. It does not extract text from receipt images or connect to a bank.</p><a className="text-button" href="/demo/northstar-studio-september-2026.csv" download><ArrowDownToLine size={14} />Download a complete sample CSV</a></div></Modal>}
    {source && <Modal title={sourceLabels[source.source]} subtitle={`${source.id} · Case ${source.groupId}`} onClose={() => setSource(null)}><div className="source-document"><div className="document-top"><ReceiptText size={25} /><span>{dataset.isDemo ? 'FICTIONAL SAMPLE RECORD' : 'IMPORTED RECORD'}</span></div><h3>{source.merchant}</h3><p>{source.description}</p><dl><div><dt>Employee</dt><dd>{source.employee || 'Not provided'}</dd></div><div><dt>Date</dt><dd>{source.date}</dd></div><div><dt>Reference</dt><dd>{source.reference || 'Not provided'}</dd></div><div><dt>Source file</dt><dd>{source.fileName}</dd></div><div className="document-amount"><dt>{source.source === 'refund' ? 'Refund amount' : 'Recorded amount'}</dt><dd>{money(source.amountCents, source.currency)}</dd></div></dl><div className="document-bottom">Shown exactly from the dataset. This view is not an independently verified original receipt.</div></div>{dataset.isDemo && <a className="button secondary full-width" href={`/demo/${encodeURIComponent(source.fileName)}`} target="_blank" rel="noreferrer">Open sample source file<ArrowUpRight size={15} /></a>}</Modal>}
    {merchantIdentityOpen && selected && <Modal title="Match this merchant" subtitle={`${selected.merchant} · Item ${selected.groupId} · Public info only`} onClose={() => setMerchantIdentityOpen(false)}>
      <div className="merchant-resolve-intro"><Globe2 size={17} /><div><strong>Match the charge to a real business</strong><p>Trace suggests real businesses that might match this charge. You confirm before anything is saved.</p></div></div>
      {(() => { const receipt = relatedRecords.find(record => record.source === 'receipt'); return receipt ? <ReceiptScan record={receipt} place={webLookup.place} /> : <div className="receipt-empty"><ReceiptText size={14} /><span>No receipt was supplied for this item — ask the employee for one before confirming a match.</span></div>; })()}
      {webLookup.status === 'loading' && <div className="web-loading"><Loader2 className="spin" size={14} />Checking public web results… This can take a few minutes.</div>}
      {webLookupErrors.length > 0 && <div className="merchant-resolve-note" role="status">{webLookupErrors.join(' ')}</div>}
      <div className="price-context-card"><div className="price-context-heading"><span><Sparkles size={15} /><strong>Is the price reasonable?</strong></span><b>{shownPrice.signal}</b></div><p>{shownPrice.note}</p><div className="price-context-range"><span>{webLookup.priceLive ? 'Typical public price range' : 'Illustrative public comparison range'}</span><strong>{shownPrice.range}</strong></div><small>Source: {priceSourceTag}</small></div>
      {webLookup.place && <p className="merchant-place"><MapPin size={13} /><span><strong>Approximate location:</strong> {webLookup.place} — from public map results; compare it with the address on the receipt before trusting the match.</span></p>}
      <div className="merchant-candidate-list">{shownCandidates.map(candidate => <div className={`merchant-candidate ${merchantMatches[selected.id] === candidate.name ? 'confirmed' : ''}`} key={candidate.name}><div className="merchant-candidate-top"><div><strong>{candidate.name}</strong><span><Globe2 size={12} />{candidate.website}</span></div><b>{candidate.confidence}%</b></div><div className="merchant-candidate-meta"><span><MapPin size={12} />{candidate.location}</span><span><Building2 size={12} />{candidate.category}</span></div><ul>{candidate.signals.map(signal => <li key={signal}><Check size={12} />{signal}</li>)}</ul><div className="merchant-candidate-bottom"><small>Source: {candidateSourceTag}</small><button className="button secondary" onClick={() => { setMerchantMatches(previous => ({ ...previous, [selected.id]: candidate.name })); setMerchantIdentityOpen(false); setToast(`Saved "${candidate.name}" as this merchant's name.`); }}>{merchantMatches[selected.id] === candidate.name ? 'Confirmed' : 'Confirm match'}</button></div></div>)}</div>
      <p className="merchant-resolve-note"><ShieldCheck size={13} />Bright Data supplies public context only. It does not access bank credentials or change accounting records.</p></Modal>}
    {investigationOpen && selected && <Modal title="A closer look" subtitle={`${selected.merchant} · Just looking — nothing is contacted or changed.`} onClose={() => setInvestigationOpen(false)}><div className="investigation-content"><div className="investigation-banner"><Sparkles size={18} /><div><strong>Evidence first</strong><p>The agent separates signals from conclusions. It does not label intent, send messages, or change the books.</p></div></div><div className="investigation-section"><h3>What may be happening</h3><p>{investigateCase(selected, relatedRecords, cases).concern}</p><p className="investigation-muted">{investigateCase(selected, relatedRecords, cases).innocent}</p></div><div className="investigation-section"><h3>Signals to check</h3><ul>{investigateCase(selected, relatedRecords, cases).signals.map(signal => <li key={signal}><Check size={14} />{signal}</li>)}</ul></div><div className="investigation-section"><h3>Pattern sweep</h3><p>{investigateCase(selected, relatedRecords, cases).recurring}</p><span className="investigation-chip">Bright Data public merchant context · directional evidence only</span></div><div className="question-box investigation-question"><div><MessageSquare size={15} /><strong>A fair question to ask</strong></div><p>{investigateCase(selected, relatedRecords, cases).question}</p><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(investigateCase(selected, relatedRecords, cases).question); setToast('Question copied. Nothing has been sent.'); } catch { setToast('Select and copy the question text above.'); } }}>Copy question<ArrowUpRight size={12} /></button></div><div className="outreach-actions"><strong>Ask the employee</strong><p>Pick a verified contact, check the question, then queue it.</p><div><button className="button secondary" onClick={() => { setOutreachChannel('email'); setOutreachOpen(true); }}><MessageSquare size={15} />Prepare email</button><button className="button secondary" onClick={() => { setOutreachChannel('text'); setOutreachOpen(true); }}><MessageSquare size={15} />Prepare text</button></div></div><p className="investigation-footer"><ShieldCheck size={14} />People still approve contact and any accounting change. The demo records the action without sending a real message.</p></div></Modal>}
    {outreachOpen && selected && <Modal title={`Send ${outreachChannel === 'email' ? 'an email' : 'a text'}`} subtitle={`${selected.merchant} · Item ${selected.groupId}`} onClose={() => setOutreachOpen(false)}><div className="review-form"><label>Verified recipient<input value={outreachRecipient} onChange={e => setOutreachRecipient(e.target.value)} placeholder={outreachChannel === 'email' ? 'employee@company.com' : '+1 555 0100'} /></label><label>Message<textarea rows={5} value={investigateCase(selected, relatedRecords, cases).question} readOnly /></label><p><ShieldCheck size={15} />Demo mode: no email or text is sent. A production connection would require an approved recipient and provider permission.</p><button className="button primary full-width" onClick={recordOutreach}><Check size={16} />Queue request</button></div></Modal>}
    {resolutionOpen && selected && <Modal title="Record your decision" subtitle={`${selected.merchant} · ${selected.groupId}`} onClose={() => setResolutionOpen(false)}><div className="review-form"><label>What's your call?<select value={decisionStatus} onChange={e => setDecisionStatus(e.target.value as Decision['status'])}><option value="confirmed">The amounts really don't match</option><option value="explained">Explained — nothing to fix</option><option value="needs_information">I need more information first</option></select></label><label>Your note<textarea rows={4} maxLength={4000} value={note} onChange={e => setNote(e.target.value)} placeholder="Which evidence supports your decision? What happens next?" /></label><p><ShieldCheck size={15} />{isBase44Configured ? 'Saves your note and case IDs to your Base44 account and this browser. No accounting entry is changed.' : 'Saves your review in this browser only. No accounting entry is changed.'}</p><button className="button primary full-width" onClick={saveDecision} disabled={!note.trim() || saving}>{saving ? <Loader2 className="spin" size={16} /> : <Check size={16} />}Save my decision</button></div></Modal>}
    {showHelp && <Modal title="A clearer way to review expenses" subtitle="Trace brings the evidence into one review workspace." onClose={() => setShowHelp(false)}><div className="help-content"><div><span>01</span><section><h3>Add your documents</h3><p>Upload one CSV with expense submissions, card charges, receipts, orders, and refunds. Give related rows the same group ID.</p></section></div><div><span>02</span><section><h3>Understand the difference</h3><p>Trace compares the amounts, accounts for split charges and refunds, and shows when evidence is missing or ambiguous.</p></section></div><div><span>03</span><section><h3>Leave a clear decision</h3><p>Review the source records, save your conclusion, and export the case for the next person. You remain responsible for the final accounting decision.</p></section></div><div className="help-callout"><strong>{isBase44Configured ? 'Base44 is configured' : 'Local preview'}</strong><p>{isBase44Configured ? 'AI drafts use Base44. Sign in to save reviews in your Base44 account. Imported datasets are not automatically uploaded.' : 'Reviews are stored in this browser. Cloud saving and AI drafting become available once the Base44 workspace is connected.'}</p>{isBase44Configured && <button className="button secondary" onClick={loginToBase44}>Sign in to Base44<ArrowUpRight size={14} /></button>}</div><button className="text-button" onClick={() => { loadDemo(); setShowHelp(false); }}>Load fictional sample data<ArrowRight size={14} /></button></div></Modal>}
  </div>;
}
// Real San Francisco street addresses so the receipt preview can be compared
// against public map results. Demo merchants get a curated real location;
// anything else falls back to a plausible SF address hashed from the name.
const RECEIPT_ADDRESSES: Record<string, { line1: string; line2: string }> = {
  'Juniper Table': { line1: '1401 Polk St', line2: 'San Francisco, CA 94109' },
  'Pine & Paper Supply': { line1: '548 Valencia St', line2: 'San Francisco, CA 94110' },
  'Lumen Workshop': { line1: '2175 Folsom St', line2: 'San Francisco, CA 94110' },
  'Fieldnote Printworks': { line1: '1045 Howard St', line2: 'San Francisco, CA 94103' },
  'Moss Digital Tools': { line1: '595 Market St Ste 2100', line2: 'San Francisco, CA 94105' },
  'Ember Catering': { line1: '2800 3rd St', line2: 'San Francisco, CA 94107' },
  'Willow Rail': { line1: '700 4th St, Caltrain Station', line2: 'San Francisco, CA 94107' },
  'Kite Studio Rentals': { line1: '1450 17th St', line2: 'San Francisco, CA 94107' },
};
const RECEIPT_STREETS = ['Mission St', 'Valencia St', 'Folsom St', 'Howard St', 'Hayes St', 'Fillmore St', 'Divisadero St', 'Irving St', 'Bryant St', 'Brannan St'];
const RECEIPT_ZIPS = ['94110', '94103', '94105', '94107', '94117', '94114', '94122', '94133'];
function hashText(text: string): number { let hash = 0; for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash; }
function mockReceiptAddress(merchant: string): { line1: string; line2: string } {
  if (RECEIPT_ADDRESSES[merchant]) return RECEIPT_ADDRESSES[merchant];
  const hash = hashText(merchant);
  return { line1: `${102 + (hash % 888)} ${RECEIPT_STREETS[hash % RECEIPT_STREETS.length]}`, line2: `San Francisco, CA ${RECEIPT_ZIPS[(hash >> 4) % RECEIPT_ZIPS.length]}` };
}
function receiptLineItems(record: SourceRecord): { label: string; cents: number }[] {
  return record.description.split(';')
    .map(part => { const match = part.match(/([^$]*?)\$\s*([\d,]+(?:\.\d{1,2})?)/); return match ? { label: match[1].trim().replace(/:?\.$/, ''), cents: Math.round(parseFloat(match[2].replace(/,/g, '')) * 100) } : null; })
    .filter((item): item is { label: string; cents: number } => !!item && !!item.label && !/total/i.test(item.label));
}
function ReceiptScan({ record, place }: { record: SourceRecord; place: string | null }) {
  const hash = hashText(record.merchant);
  const address = mockReceiptAddress(record.merchant);
  const items = receiptLineItems(record);
  const publicName = place?.split('·')[0]?.trim().toLowerCase() || '';
  const receiptName = record.merchant.toLowerCase();
  const nameMatch = !!publicName && (publicName.includes(receiptName.split(' ')[0]) || receiptName.includes(publicName.split(' ')[0]));
  const time = `${8 + (hash % 10)}:${String(10 + (hash % 50)).padStart(2, '0')} PM`;
  const last4 = String(1000 + (hash % 9000));
  const phone = `(${300 + (hash % 700)}) 555-${String(hash % 10000).padStart(4, '0')}`;
  return (
    <div className="receipt-scan">
      <div className="receipt-paper" aria-label="Receipt preview">
        <header><strong>{record.merchant.toUpperCase()}</strong><span>{address.line1}</span><span>{address.line2}</span><span>{phone}</span></header>
        <div className="receipt-rule" />
        <div className="receipt-meta"><span>{record.date}</span><span>{time}</span></div>
        <div className="receipt-rule dashed" />
        {items.length > 0 ? items.map(item => <div className="receipt-item" key={item.label}><span>{item.label}</span><span>{money(item.cents, record.currency)}</span></div>) : <div className="receipt-item"><span>Itemized detail not captured</span><span /></div>}
        <div className="receipt-rule dashed" />
        <div className="receipt-total"><span>TOTAL</span><span>{money(record.amountCents, record.currency)}</span></div>
        <div className="receipt-meta"><span>VISA •••• {last4}</span><span>AUTH OK</span></div>
        <div className="receipt-barcode" />
        <footer>THANK YOU · KEEP THIS RECEIPT</footer>
      </div>
      <div className="receipt-fields">
        <h4>Read from the receipt</h4>
        <div className="receipt-field"><span>Merchant name</span><strong>{record.merchant}</strong>{publicName ? <em className={nameMatch ? 'match' : 'diff'}>{nameMatch ? 'Matches the public result' : 'Differs from the public result'}</em> : null}</div>
        <div className="receipt-field"><span>Receipt location</span><strong>{address.line1}, {address.line2}</strong></div>
        {place && <div className="receipt-field"><span>Public result</span><strong>{place}</strong></div>}
        <div className="receipt-field"><span>Charged</span><strong>{money(record.amountCents, record.currency)} · {record.date}</strong></div>
        <p className="receipt-note"><ReceiptText size={12} /><span>Illustrative receipt preview — name, date, items, and total come from the receipt record; the street address is a placeholder until document scanning is connected.</span></p>
      </div>
    </div>
  );
}
function Empty({ title, subtitle }: { title: string; subtitle: string }) { return <div className="empty-state"><FileCheck2 size={30} /><h3>{title}</h3><p>{subtitle}</p></div>; }
function TourOverlay({ index, total, step, onBack, onNext, onSkip }: { index: number; total: number; step: TourStep; onBack: () => void; onNext: () => void; onSkip: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const measure = () => { const el = step.selector ? document.querySelector(step.selector) : null; setRect(el ? el.getBoundingClientRect() : null); };
    step.selector && document.querySelector(step.selector)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    measure();
    const settle = setTimeout(measure, 380);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onSkip(); };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('keydown', esc);
    return () => { clearTimeout(settle); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); document.removeEventListener('keydown', esc); };
  }, [step, onSkip]);
  const pad = 9;
  const tipStyle: React.CSSProperties = {};
  if (rect) {
    const below = rect.bottom + 190 < window.innerHeight;
    tipStyle.left = Math.max(14, Math.min(rect.left + rect.width / 2 - 142, window.innerWidth - 300));
    tipStyle.top = below ? rect.bottom + 20 : Math.max(14, rect.top - 200);
  }
  return <>
    <div className="tour-blocker" />
    {rect && <div className="tour-spotlight" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />}
    <div className={`tour-tooltip${rect ? '' : ' centered'}`} style={tipStyle} role="dialog" aria-label={`Tour step ${index + 1}: ${step.title}`}>
      <span className="tour-count">Step {index + 1} of {total}</span>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
      <div className="tour-actions"><button className="text-button" onClick={onSkip}>Skip tour</button>{index > 0 && <button className="button secondary" onClick={onBack}>Back</button>}<button className="button primary" onClick={onNext}>{index === total - 1 ? 'Got it — start checking' : 'Next'}<ArrowRight size={14} /></button></div>
    </div>
  </>;
}
function KindDonut({ cases }: { cases: ReviewCase[] }) {
  const order = ['amount_difference', 'missing_evidence', 'ambiguous', 'matched', 'split_purchase'];
  const segments = order.map(kind => ({ kind, n: cases.filter(c => c.kind === kind).length })).filter(s => s.n > 0);
  const total = cases.length || 1;
  let covered = 0;
  return <svg viewBox="0 0 42 42" className="glance-donut-svg" role="img" aria-label="How your items stack up">
    <circle cx="21" cy="21" r="15.915" fill="none" stroke="#eef1ea" strokeWidth="6" />
    {segments.map(s => { const pct = (s.n / total) * 100; const el = <circle key={s.kind} cx="21" cy="21" r="15.915" fill="none" stroke={KIND_COLORS[s.kind]} strokeWidth="6" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={25 - covered} />; covered += pct; return el; })}
    <text x="21" y="21" textAnchor="middle" dominantBaseline="central" className="donut-num">{cases.length}</text>
  </svg>;
}
function TrailTimeline({ records, onOpen }: { records: SourceRecord[]; onOpen: (r: SourceRecord) => void }) {
  const sorted = useMemo(() => [...records].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), [records]);
  const [tick, setTick] = useState(sorted.length);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setTick(sorted.length); setPlaying(false); }, [sorted]);
  useEffect(() => { if (!playing) return; if (tick >= sorted.length) { setPlaying(false); return; } const t = setTimeout(() => setTick(v => v + 1), 550); return () => clearTimeout(t); }, [playing, tick, sorted.length]);
  return <div className="trail-watch">
    <div className="trail-track"><span className="trail-line" />{sorted.map((r, i) => <button key={r.id} type="button" className={`trail-dot${i % 2 ? ' alt' : ''}${i < tick ? ' shown' : ''}`} style={{ left: `${sorted.length === 1 ? 50 : (i / (sorted.length - 1)) * 100}%` }} onClick={() => onOpen(r)} title={`${sourceLabels[r.source]} · ${recordDate(r.date)} — open this document`}><i style={{ background: SOURCE_COLORS[r.source] }} /><em>{recordDate(r.date)}</em></button>)}</div>
    <button className="text-button trail-replay" type="button" onClick={() => { setTick(0); setPlaying(true); }} disabled={playing}><Play size={12} />{playing ? 'Replaying…' : 'Replay in order'}</button>
  </div>;
}
function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: React.ReactNode; onClose: () => void }) { const panel = useRef<HTMLDivElement>(null); useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); const trap = (e: KeyboardEvent) => { if (e.key !== 'Tab') return; const elements = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([hidden]),select,textarea,[tabindex="0"]'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }; document.addEventListener('keydown', trap); return () => { document.removeEventListener('keydown', trap); previous?.focus(); }; }, []); return <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><button className="modal-close icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button><h2>{title}</h2><p className="modal-subtitle">{subtitle}</p>{children}</div></div>; }
export default App;
