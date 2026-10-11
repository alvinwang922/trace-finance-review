# Trace

Trace is a finance-operations review workspace prototype. It brings expense submissions, receipts, card activity, refunds, and accounting evidence into one case so a reviewer can understand a discrepancy and choose the next action.

## Local development

```bash
cd expense-review
npm install
npm run dev
```

The app uses fictional sample records by default. To connect the Base44 workspace locally, create `expense-review/.env.local` from `.env.example` and add the public app ID and app URL. Environment files are ignored and should never be committed.

## Outside check (Bright Data)

Inside each review, Trace checks whether the case shares an outside factor with other people's cases (same card network or processor, same few days). If it does, the case shows an **Outside check**: the other cases with the same factor, a **Check with Bright Data** button that searches and reads public pages for an outside cause, the ruling with its quoted source, and **Apply to all** to close the whole group at once. Example: four employees' Visa bill payments posted twice on April 11–12, 2025; Trace finds the public notice of Visa's duplicate-settlement weekend, clears all four, and drafts the disputes. The banner at the top of the review queue shows how many mismatches share an outside factor; on the September sample it offers **Try the April 2025 statement**.

- Grouping, scoring and rulings are deterministic and unit-tested (`src/lib/worldContext.ts`). Every ruling links the public source it rests on; with no matching source, the cases stay with a reviewer.
- Bright Data is only queried with the network, processor and dates. No employee or card data leaves the app.
- **Local:** add `BRIGHTDATA_API_KEY=...` to `expense-review/.env.local`. The Vite dev server proxies research at `/api/world-research`; the key never reaches the browser bundle.
- **Hosted:** deploy the `worldResearch` Base44 function and set its secret (see `expense-review/base44/README.md`). Signed-in users only.
- **Offline demo:** `public/demo/world-context-recorded.json` is a recorded live run. Re-record with `BRIGHTDATA_API_KEY=... node scripts/record-world-context.ts` (Node 23.6+).

## Validation

```bash
cd expense-review
npm run build
```

The `research/` directory contains Sense interview outputs and notes that informed the prototype.
