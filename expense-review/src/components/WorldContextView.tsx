import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, FileText, Globe2, ListFilter, Loader2, PlayCircle, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import type { Dataset } from '../lib/types';
import { describeWindow, runWorldResearch, type ResearchRun, type ResearchStep, type WorldCluster, type WorldContext } from '../lib/worldContext';
import { liveResearchAvailable, researchTransport } from '../lib/research';
import { worldDemoDataset } from '../data/worldDemo';

interface Props {
  dataset: Dataset;
  context: WorldContext;
  onLoadDemo: () => void;
  onOpenCase: (caseId: string) => void;
  onToast: (message: string) => void;
  /** How many employees a group-by-person view would flag before outside factors are removed. */
  personPatterns?: number;
}

interface Recorded { datasetId: string; recordedAt: string; runs: ResearchRun[] }

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
      return <li key={index} className={`world-step ${step.kind}`}><Icon size={14} /><span>{step.text}</span></li>;
    })}
    {running && <li className="world-step pending"><Loader2 className="spin" size={14} /><span>Working through Bright Data…</span></li>}
  </ol>;
}

function RunResult({ run, cluster }: { run: ResearchRun; cluster: WorldCluster }) {
  const { ruling } = run;
  return <div className={`world-ruling ${ruling.verdict}`}>
    <div className="world-ruling-top"><span className="world-verdict">{verdictLabels[ruling.verdict]}</span><small>{run.mode === 'live' ? 'Live Bright Data run' : 'Recorded Bright Data run'} · {time(run.finishedAt)}</small></div>
    <h3>{ruling.headline}</h3>
    <p>{ruling.detail}</p>
    {ruling.quote && <blockquote>“{ruling.quote.replace(/^[“"\s]+|[”"\s]+$/g, '')}”{ruling.sourceUrl && <a href={ruling.sourceUrl} target="_blank" rel="noreferrer">{domain(ruling.sourceUrl)}<ArrowUpRight size={12} /></a>}</blockquote>}
    <ul className="world-actions">{ruling.actions.map((action) => <li key={action}><Check size={13} />{action}</li>)}</ul>
    <p className="world-draft-note"><ShieldCheck size={13} />Drafts only. Nothing is sent, filed or posted until a person approves it.</p>
    {run.sources.length > 0 && <details className="world-sources"><summary>{run.sources.length} public sources checked for {cluster.cases.length} cases</summary>
      <ul>{run.sources.slice(0, 6).map((source) => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noreferrer">{source.title || domain(source.url)}<ArrowUpRight size={11} /></a>
        <span>{domain(source.url)}</span>
        <div className="world-match">{(['event', 'date', 'network', 'processor'] as const).filter((key) => source.matched[key]).map((key) => <i key={key}>{key}</i>)}{source.strong && <b>match</b>}</div>
      </li>)}</ul>
    </details>}
  </div>;
}

export function WorldContextView({ dataset, context, onLoadDemo, onOpenCase, onToast, personPatterns = 0 }: Props) {
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

  async function investigate(cluster: WorldCluster) {
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
  }

  function showRecorded(cluster: WorldCluster) {
    const run = recorded?.runs.find((item) => item.clusterId === cluster.id);
    if (run) setRuns((previous) => ({ ...previous, [cluster.id]: run }));
  }

  const totalCases = context.clusters.reduce((total, cluster) => total + cluster.cases.length, 0);

  return <section className="world-panel" aria-label="World context">
    <div className="world-intro">
      <Globe2 size={20} />
      <div>
        <strong>Look outside before you look at people.</strong>
        <p>Trace groups mismatches that share an outside factor (the same card network or payment processor, the same few days) across different employees. It then searches the public web with Bright Data for an outside cause before anyone is contacted.</p>
      </div>
    </div>

    {!context.clusters.length && <div className="world-empty">
      <h3>No shared outside factors in this dataset.</h3>
      <p>Each mismatch here involves one person and one purchase, so it stays in the review queue. Try the April 2025 statement: four employees' bill payments posted twice on the same weekend, and three restaurant charges settled above the receipt.</p>
      <button className="button primary" onClick={onLoadDemo}>Load the April 2025 card statement<ArrowRight size={15} /></button>
    </div>}

    {context.clusters.length > 0 && <div className="world-summary">
      <span><strong>{totalCases + context.isolated.length}</strong> mismatches</span><ArrowRight size={14} />
      <span><strong>{context.clusters.length}</strong> shared outside factors ({totalCases} cases)</span><ArrowRight size={14} />
      <span><strong>{context.isolated.length}</strong> left for a person</span>
    </div>}
    {context.clusters.length > 0 && personPatterns > 0 && <p className="world-contrast">Grouped by person, these mismatches would flag <strong>{personPatterns} employee{personPatterns === 1 ? '' : 's'}</strong> for repeated differences. Grouped by outside factor, {totalCases} of {totalCases + context.isolated.length} have a shared cause to check first.</p>}

    {context.clusters.map((cluster) => {
      const run = runs[cluster.id];
      const hasRecorded = Boolean(recorded?.runs.some((item) => item.clusterId === cluster.id));
      const isRunning = running === cluster.id;
      return <article className="world-cluster" key={cluster.id}>
        <header>
          <div className={`world-cluster-icon ${cluster.signature}`}><Globe2 size={17} /></div>
          <div>
            <h3>{cluster.title}</h3>
            <div className="world-chips">
              {cluster.network && <span>{cluster.network}</span>}
              {cluster.processor && <span>{cluster.processor}</span>}
              <span>{describeWindow(cluster.windowStart, cluster.windowEnd)}</span>
              <span>{money(cluster.totalCents, cluster.currency)} {cluster.signature === 'duplicate_settlement' ? 'posted twice' : 'above receipts'}</span>
            </div>
          </div>
        </header>
        <p className="world-why">{cluster.why}</p>
        <div className="world-cases">
          {cluster.cases.map((item) => <button key={item.groupId} onClick={() => onOpenCase(item.caseId)}>
            <strong>{item.merchant}</strong><span>{item.employee}</span><span>{item.date}</span><b>{money(item.amountCents, item.currency)}</b><ArrowUpRight size={12} />
          </button>)}
        </div>
        <div className="world-hypothesis"><Sparkles size={14} /><div><strong>Hypothesis to test</strong><p>{cluster.hypothesis.label}</p></div></div>
        <div className="world-buttons">
          <button className="button primary" disabled={!liveResearchAvailable || Boolean(running)} onClick={() => investigate(cluster)} title={liveResearchAvailable ? 'Search the public web through Bright Data now' : 'Connect Base44 to run live research'}>
            {isRunning ? <Loader2 className="spin" size={15} /> : <Search size={15} />}{isRunning ? 'Investigating…' : 'Investigate with Bright Data'}
          </button>
          {hasRecorded && <button className="button secondary" disabled={isRunning} onClick={() => showRecorded(cluster)}><PlayCircle size={15} />Show recorded run</button>}
        </div>
        {isRunning && <Steps steps={liveSteps} running />}
        {!isRunning && run && <><Steps steps={run.steps} running={false} /><RunResult run={run} cluster={cluster} /></>}
      </article>;
    })}

    {context.isolated.length > 0 && <div className="world-isolated">
      <h3>No shared outside factor</h3>
      <p>These mismatches don't line up with any other person, processor or date, so there is nothing outside to check. They stay with a reviewer.</p>
      {context.isolated.map((item) => <button key={item.id} onClick={() => onOpenCase(item.id)}><strong>{item.merchant}</strong><span>{item.employee}</span><span>{item.title}</span><ArrowUpRight size={12} /></button>)}
    </div>}

    <p className="world-guardrail"><ShieldCheck size={14} />Bright Data is only pointed at public notices, processors and merchants, never at employees. Searches contain only the card network, processor and dates.</p>
  </section>;
}
