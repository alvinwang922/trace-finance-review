import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, FileText, Globe2, ListFilter, Loader2, PlayCircle, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Dataset } from '../lib/types';
import { describeWindow, runWorldResearch, type ResearchRun, type ResearchStep, type Ruling, type WorldCluster } from '../lib/worldContext';
import { liveResearchAvailable, researchTransport } from '../lib/research';
import { worldDemoDataset } from '../data/worldDemo';

interface Recorded { datasetId: string; recordedAt: string; runs: ResearchRun[] }

/** Research state is shared across the cases of a group, so switching cases keeps the result. */
export interface WorldResearch {
  runs: Record<string, ResearchRun>;
  running: string | null;
  liveSteps: ResearchStep[];
  hasRecorded: (clusterId: string) => boolean;
  investigate: (cluster: WorldCluster) => Promise<void>;
  showRecorded: (cluster: WorldCluster) => void;
  /** Run once per group automatically: live when available, else the recorded run. */
  ensure: (cluster: WorldCluster) => void;
}

const RUNS_KEY = 'trace-outside-runs-v1';
function readRuns(datasetId: string): Record<string, ResearchRun> {
  try { return (JSON.parse(localStorage.getItem(RUNS_KEY) || '{}') as Record<string, Record<string, ResearchRun>>)[datasetId] ?? {}; } catch { return {}; }
}
function saveRuns(datasetId: string, runs: Record<string, ResearchRun>) {
  try {
    const all = JSON.parse(localStorage.getItem(RUNS_KEY) || '{}') as Record<string, Record<string, ResearchRun>>;
    localStorage.setItem(RUNS_KEY, JSON.stringify({ ...all, [datasetId]: runs }));
  } catch { /* Results stay in memory if storage is unavailable. */ }
}

export function useWorldResearch(dataset: Dataset, onToast: (message: string) => void): WorldResearch {
  // Saved per dataset, so reopening a case doesn't spend Bright Data credits again.
  const [runs, setRuns] = useState<Record<string, ResearchRun>>(() => readRuns(dataset.id));
  const [running, setRunning] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<ResearchStep[]>([]);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  // Effects can run twice in development; never start two runs for the same group.
  const inFlight = useRef(new Set<string>());
  const attempted = useRef(new Set<string>());

  useEffect(() => { saveRuns(dataset.id, runs); }, [dataset.id, runs]);

  useEffect(() => {
    setRuns(readRuns(dataset.id));
    setRecorded(null);
    if (dataset.id !== worldDemoDataset.id) return;
    let active = true;
    fetch('/demo/world-context-recorded.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Recorded | null) => { if (active && data?.datasetId === dataset.id) setRecorded(data); })
      .catch(() => {});
    return () => { active = false; };
  }, [dataset.id]);

  const showRecorded = (cluster: WorldCluster) => {
    const run = recorded?.runs.find((item) => item.clusterId === cluster.id);
    if (run) setRuns((previous) => ({ ...previous, [cluster.id]: run }));
    return Boolean(run);
  };
  const investigate = async (cluster: WorldCluster) => {
    if (inFlight.current.has(cluster.id)) return;
    inFlight.current.add(cluster.id);
    setRunning(cluster.id);
    setLiveSteps([]);
    try {
      const run = await runWorldResearch(cluster, researchTransport, (step) => setLiveSteps((previous) => [...previous, step]));
      // A run that hit errors doesn't replace a complete earlier result.
      const failed = run.steps.some((step) => step.kind === 'error');
      setRuns((previous) => {
        if (failed && previous[cluster.id]) { onToast('The live re-check could not finish; keeping the earlier Bright Data result.'); return previous; }
        return { ...previous, [cluster.id]: run };
      });
    } catch (error) {
      if (!showRecorded(cluster)) onToast(error instanceof Error ? error.message : 'Public-web research failed.');
    } finally {
      inFlight.current.delete(cluster.id);
      setRunning(null);
    }
  };
  return {
    runs, running, liveSteps,
    investigate,
    showRecorded: (cluster) => { showRecorded(cluster); },
    ensure(cluster) {
      // Show a saved result instantly, then re-check live once in the background.
      if (!runs[cluster.id]) showRecorded(cluster);
      if (!liveResearchAvailable || running || attempted.current.has(cluster.id) || (runs[cluster.id]?.mode === 'live')) return;
      attempted.current.add(cluster.id);
      void investigate(cluster);
    },
    hasRecorded: (clusterId) => Boolean(recorded?.runs.some((item) => item.clusterId === clusterId)),
  };
}

const stepIcons = { plan: Sparkles, search: Search, score: ListFilter, read: FileText, rule: ShieldCheck, error: X };
const verdictLabels = { outside_event: 'Outside event', shared_mechanism: 'Shared cause', no_outside_cause: 'No outside cause' };

function money(cents: number, currency: string) {
  return `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function domain(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function time(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function Steps({ steps, running }: { steps: ResearchStep[]; running: boolean }) {
  return <ol className="world-steps">
    {steps.map((step, index) => {
      const Icon = stepIcons[step.kind];
      return <li key={index} className={`world-step ${step.kind}`}><Icon size={13} /><span>{step.text}</span></li>;
    })}
    {running && <li className="world-step pending"><Loader2 className="spin" size={13} /><span>Working through Bright Data…</span></li>}
  </ol>;
}

interface OutsideCheckProps {
  cluster: WorldCluster;
  selectedCaseId: string;
  research: WorldResearch;
  appliedCount: number;
  onOpenCase: (caseId: string) => void;
  onApplyToAll: (cluster: WorldCluster, ruling: Ruling) => void;
}

/** Shown inside a case when it shares an outside factor with other people's cases. */
export function OutsideCheck({ cluster, selectedCaseId, research, appliedCount, onOpenCase, onApplyToAll }: OutsideCheckProps) {
  const run = research.runs[cluster.id];
  const isRunning = research.running === cluster.id;
  const ruling = run?.ruling;
  const others = cluster.cases.filter((item) => item.caseId !== selectedCaseId);
  // Check automatically when the case opens; one group at a time, then the next.
  useEffect(() => { research.ensure(cluster); }, [cluster.id, research.running]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`outside-check ${ruling?.verdict ?? ''}`}>
    <div className="outside-check-top"><Globe2 size={15} /><strong>Outside check</strong><span>Before anyone is contacted</span></div>
    <h3>{cluster.title}</h3>
    <p className="outside-why">{cluster.why}</p>
    <div className="outside-chips">
      {cluster.network && <span>{cluster.network}</span>}
      {cluster.processor && <span>{cluster.processor}</span>}
      <span>{describeWindow(cluster.windowStart, cluster.windowEnd)}</span>
      <span>{money(cluster.totalCents, cluster.currency)} {cluster.signature === 'duplicate_settlement' ? 'posted twice' : 'above receipts'}</span>
    </div>
    <div className="outside-siblings">
      <small>This case and {others.length} other{others.length === 1 ? '' : 's'} with the same factor</small>
      {cluster.cases.map((item) => <button key={item.caseId} className={item.caseId === selectedCaseId ? 'current' : ''} onClick={() => onOpenCase(item.caseId)} disabled={item.caseId === selectedCaseId}>
        <strong>{item.merchant}</strong><span>{item.employee}</span><b>{money(item.amountCents, item.currency)}</b>{item.caseId === selectedCaseId ? <i>this case</i> : <ArrowRight size={11} />}
      </button>)}
    </div>
    {!ruling && <div className="outside-hypothesis"><Sparkles size={13} /><span><strong>Checking with Bright Data:</strong> {cluster.hypothesis.label}</span></div>}
    {isRunning && !run && <Steps steps={research.liveSteps} running />}
    {isRunning && run && <p className="outside-waiting"><Loader2 className="spin" size={12} />Re-checking live with Bright Data… {research.liveSteps.length ? research.liveSteps[research.liveSteps.length - 1].text : ''}</p>}
    {!ruling && !isRunning && research.running && <p className="outside-waiting"><Loader2 className="spin" size={12} />Waiting for the other group's check to finish…</p>}
    {run && <>
      <div className="outside-run-meta"><details className="outside-steps"><summary>{run.mode === 'live' ? 'Live Bright Data run' : 'Recorded Bright Data run'} · {time(run.finishedAt)} · {run.steps.length} steps</summary><Steps steps={run.steps} running={false} /></details>
        <span>{liveResearchAvailable && <button className="text-button" disabled={Boolean(research.running)} onClick={() => research.investigate(cluster)}><Search size={11} />Re-check live</button>}{research.hasRecorded(cluster.id) && run.mode === 'live' && <button className="text-button" onClick={() => research.showRecorded(cluster)}><PlayCircle size={11} />Recorded run</button>}</span></div>
      <div className={`world-ruling ${run.ruling.verdict}`}>
        <div className="world-ruling-top"><span className="world-verdict">{verdictLabels[run.ruling.verdict]}</span></div>
        <h3>{run.ruling.headline}</h3>
        <p>{run.ruling.detail}</p>
        {run.ruling.quote && <blockquote>“{run.ruling.quote.replace(/^[“"\s]+|[”"\s]+$/g, '')}”{run.ruling.sourceUrl && <a href={run.ruling.sourceUrl} target="_blank" rel="noreferrer">{domain(run.ruling.sourceUrl)}<ArrowUpRight size={12} /></a>}</blockquote>}
        {run.ruling.breakdown && run.ruling.breakdown.length > 0 && <div className="outside-breakdown"><small>Breakdown</small>{run.ruling.breakdown.map((row) => {
          const check = run.merchantChecks?.find((entry) => row.label.startsWith(`${entry.merchant} ·`));
          return <div key={row.caseId} className={row.ok ? 'ok' : 'no'}>{row.ok ? <Check size={12} /> : <X size={12} />}<span><strong>{row.label}</strong>{row.detail}{check?.url && <a href={check.url} target="_blank" rel="noreferrer">{domain(check.url)}<ArrowUpRight size={10} /></a>}</span></div>;
        })}</div>}
        <ul className="world-actions">{run.ruling.actions.map((action) => <li key={action}><Check size={13} />{action}</li>)}</ul>
        {run.ruling.verdict !== 'no_outside_cause' && <button className="button primary" disabled={appliedCount === cluster.cases.length} onClick={() => onApplyToAll(cluster, run.ruling)}>
          <CheckCheck size={14} />{appliedCount === cluster.cases.length ? `Applied to all ${cluster.cases.length} cases` : `Apply to all ${cluster.cases.length} cases`}
        </button>}
        <p className="world-draft-note"><ShieldCheck size={13} />Drafts only. Disputes and corrections wait for a person; nothing is sent or posted.</p>
      </div>
    </>}
  </div>;
}
