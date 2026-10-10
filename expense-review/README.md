# Trace

Trace is an expense-review prototype for finance operations staff and bookkeepers. Its **Save time** goal is to reduce the work of comparing already-linked records, explaining differences, and documenting a human review.

[Open the Base44 app](https://trace-expense-review-f366fc9e.base44.app) — workspace access is required. Authenticated AI drafting with record citations, cloud review saving, and cloud review loading were verified on the hosted app with fictional data on October 10, 2026. The production build and all 40 calculation, import, and citation checks pass.

## Run locally

Use Node.js 22.12 or later on the 22.x release line, or Node.js 24 LTS, with npm. From this directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. To run the calculation/import tests and create a production build:

```bash
npm test
npm run build
npm run preview
```

The app works locally without Base44. For authenticated AI explanation drafts and cloud review storage, follow [Base44 connection setup](base44/README.md).

## What works

- Import a combined CSV, validate its fields, and compare records grouped by an explicit case ID.
- Compare expense submissions, receipt totals, and card charges; account for split shipments and recorded refunds.
- Separate amount differences from missing evidence and ambiguous cases.
- Inspect source records, save a reviewer conclusion, and export a plain-text evidence report.
- With Base44 configured and the reviewer signed in, request a cited AI explanation, save review notes to the account, and restore cloud reviews.

Amounts are calculated using integer cents. AI supplies an optional writing draft; it does not calculate or approve the finding. Local imports and reviews are stored in this browser. The AI action sends the selected case's record fields and calculations to Base44; cloud review saves send the case IDs, status, and reviewer note. Neither action uploads original documents automatically.

This version does not read receipt images or PDFs, infer which unrelated records belong together, connect to banks, send employee messages, or change accounting entries. Agreement between amounts does not establish business purpose, policy compliance, or an absence of fraud. A difference does not establish its cause or money recovered.

## CSV input

Use [the sample CSV](public/demo/northstar-studio-september-2026.csv) as the template. Imports must be smaller than 5 MB. Required columns are:

```text
id,groupId,date,merchant,employee,source,amount,currency,description
```

`reference` and `fileName` are optional. Each `id` must be unique. `groupId` explicitly links records for one purchase; Trace trusts this supplied grouping and does not independently verify it. Use `YYYY-MM-DD` dates, three-letter currency codes, and positive decimal amounts without currency symbols or thousands separators. Source types are `expense`, `card`, `receipt`, `order`, and `refund`.

Provide receipt and card amounts before refunds, and represent each posted refund once as a positive `refund` row. The calculation subtracts that credit once from each comparison total. An `order` is supporting context, not additional spend. Use one expense submission per group; multiple submissions remain ambiguous. Mixed currencies are not converted.

The fictional Northstar Studio sample contains 35 records in 10 groups. Each record has a readable source excerpt in [public/demo](public/demo/), served at `/demo/<record-id>.txt`. These are original demo text documents, not OCR results or client records. Importing a CSV does not upload the documents named in its rows.

## Two-minute demo

1. Load the fictional sample from the help dialog. Open **Juniper Table / G01**: the submission is $114 while the receipt and card show $112. Open a source record and explain that this identifies a $2 difference without proving the cause.
2. Choose **All cases**, then **Pine & Paper Supply / G02**. Two shipments total $300; a $40 refund leaves $260, agreeing with the submitted expense. Different line amounts do not necessarily mean an error.
3. Open **Harbor Car Service / G04** and **Common Ground Coffee / G05**. Show why missing receipts and multiple submissions remain unresolved instead of being called fraud.
4. Return to G01, select **Review case**, add an evidence-based note, and save. Export the case. Once AI citation handling has been verified, an optional extension is to generate a draft and check its cited records.

## Evidence boundary

The starting research is one Sense AI interview. Its [full transcript](../research/sense-full-transcript-tester1-20261010T210912Z.txt) became available at 2:09 PM Pacific on October 10, 2026; this is the same first participant, not an additional interview. They described reviewing QuickBooks Online details and Chase company-card records across several months after receipt submissions disagreed over gratuity, involving two interns and a conversation with the employee. They want employees to verify entries, and report that weekly checks make monthly review quicker.

The transcript contains repeated questions and unclear fragments and has not been checked against audio. It does not establish which step took most of the time. The incomplete phrase “two to three hours a” cannot support a daily, weekly, or monthly time estimate.

The demo tests a product hypothesis. It does not reproduce that participant's actual records, demonstrate willingness to pay, or establish a market gap. Validate with finance users by comparing investigation time and correctness on equivalent cases, including how much of the app's work they need to recheck.
