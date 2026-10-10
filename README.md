# Trace

Trace is a finance-operations review workspace prototype. It brings expense submissions, receipts, card activity, refunds, and accounting evidence into one case so a reviewer can understand a discrepancy and choose the next action.

## Local development

```bash
cd expense-review
npm install
npm run dev
```

The app uses fictional sample records by default. To connect the Base44 workspace locally, create `expense-review/.env.local` from `.env.example` and add the public app ID and app URL. Environment files are ignored and should never be committed.

## Validation

```bash
cd expense-review
npm run build
```

The `research/` directory contains Sense interview outputs and notes that informed the prototype.
