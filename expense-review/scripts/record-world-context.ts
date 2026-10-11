/**
 * Runs World context research for the April 2025 demo statement against the live
 * Bright Data API and saves the result, so the demo still works on bad venue Wi-Fi.
 *
 *   BRIGHTDATA_API_KEY=... node scripts/record-world-context.ts
 *
 * Requires Node 23.6+ (runs TypeScript directly). The key is read from the environment
 * and never written to the output.
 */
import { writeFileSync } from 'node:fs';
import { worldDemoDataset } from '../src/data/worldDemo.ts';
import { analyzeDataset } from '../src/lib/engine.ts';
import { findWorldContext, runWorldResearch } from '../src/lib/worldContext.ts';
import { scrapeMany, searchMany } from '../base44/functions/worldResearch/brightdata.ts';

const token = process.env.BRIGHTDATA_API_KEY;
if (!token) {
  console.error('Set BRIGHTDATA_API_KEY first.');
  process.exit(1);
}

const context = findWorldContext(worldDemoDataset, analyzeDataset(worldDemoDataset));
const runs = [];
for (const cluster of context.clusters) {
  console.log(`\n${cluster.title}`);
  const run = await runWorldResearch(cluster, {
    search: (queries) => searchMany(token, queries),
    scrape: (urls) => scrapeMany(token, urls),
  }, (step) => console.log(`  [${step.kind}] ${step.text}`));
  runs.push({ ...run, mode: 'recorded' });
}

const output = new URL('../public/demo/world-context-recorded.json', import.meta.url);
writeFileSync(output, `${JSON.stringify({ datasetId: worldDemoDataset.id, recordedAt: new Date().toISOString(), runs }, null, 2)}\n`);
console.log(`\nSaved ${runs.length} recorded runs to public/demo/world-context-recorded.json`);
