import { useEffect, useState } from 'react';
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
}

export function useWorldResearch(dataset: Dataset, onToast: (message: string) => void): WorldResearch {
  const [runs, setRuns] = useState<Record<string, ResearchRun>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<ResearchStep[]>([]);
  const [recorded, setRecorded] = useState<Recorded | null>(null);

  useEffect(() => {
    setRuns({});
    setRecorded(null);
    if (dataset.id !== worldDemoDataset.id) return;
    let active = true;
    fetch('/demo/world-context-recorded.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Recorded | null) => { if (active && data?.datasetId === dataset.id) setRecorded(data); })
      .catch(() => {});
    return () => { active = false; };
  }, [dataset.id]);

  return {
    runs, running, liveSteps,
    hasRecorded: (clusterId) => Boolean(recorded?.runs.some((item) => item.clusterId === clusterId)),
    async investigate(cluster) {
      setRunning(cluster.id);
      setLiveSteps([]);
      try {
        const run = await runWorldResearch(cluster, researchTransport, (step) => setLiveSteps((previous) => [...previous, step]));
        setRuns((previous) => ({ ...previous, [cluster.id]: run }));
      } catch (error) {
        onToast(error instanceof Error ? error.message : 'Public-web research failed. Show the recorded run instead.');
      } finally {
        setRunning(null);
      }
    },
    showRecorded(cluster) {
      const run = recorded?.runs.find((item) => item.clusterId === cluster.id);
      if (run) setRuns((previous) => ({ ...previous, [cluster.id]: run }));
    },
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
    {!ruling && !isRunning && <div className="outside-hypothesis"><Sparkles size={13} /><span><strong>Hypothesis:</strong> {cluster.hypothesis.label}</span></div>}
    {!ruling && <div className="world-buttons">
      <button className="button primary" disabled={!liveResearchAvailable || Boolean(research.running)} onClick={() => research.investigate(cluster)} title={liveResearchAvailable ? 'Search the public web through Bright Data now' : 'Connect Base44 to run live research'}>
        {isRunning ? <Loader2 className="spin" size={14} /> : <Search size={14} />}{isRunning ? 'Checking the public web…' : 'Check with Bright Data'}
      </button>
      {research.hasRecorded(cluster.id) && <button className="button secondary" disabled={isRunning} onClick={() => research.showRecorded(cluster)}><PlayCircle size={14} />Show recorded run</button>}
    </div>}
    {isRunning && <Steps steps={research.liveSteps} running />}
    {run && !isRunning && <>
      <details className="outside-steps"><summary>{run.mode === 'live' ? 'Live Bright Data run' : 'Recorded Bright Data run'} · {time(run.finishedAt)} · {run.steps.length} steps</summary><Steps steps={run.steps} running={false} /></details>
      <div className={`world-ruling ${run.ruling.verdict}`}>
        <div className="world-ruling-top"><span className="world-verdict">{verdictLabels[run.ruling.verdict]}</span></div>
        <h3>{run.ruling.headline}</h3>
        <p>{run.ruling.detail}</p>
        {run.ruling.quote && <blockquote>“{run.ruling.quote.replace(/^[“"\s]+|[”"\s]+$/g, '')}”{run.ruling.sourceUrl && <a href={run.ruling.sourceUrl} target="_blank" rel="noreferrer">{domain(run.ruling.sourceUrl)}<ArrowUpRight size={12} /></a>}</blockquote>}
        <ul className="world-actions">{run.ruling.actions.map((action) => <li key={action}><Check size={13} />{action}</li>)}</ul>
        {run.ruling.verdict !== 'no_outside_cause' && <button className="button primary" disabled={appliedCount === cluster.cases.length} onClick={() => onApplyToAll(cluster, run.ruling)}>
          <CheckCheck size={14} />{appliedCount === cluster.cases.length ? `Applied to all ${cluster.cases.length} cases` : `Apply to all ${cluster.cases.length} cases`}
        </button>}
        <p className="world-draft-note"><ShieldCheck size={13} />Drafts only. Disputes and corrections wait for a person; nothing is sent or posted.</p>
      </div>
    </>}
  </div>;
}
