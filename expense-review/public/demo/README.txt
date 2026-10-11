NORTHSTAR STUDIO — FICTIONAL DEMO DATA

All people, merchants, transactions and source excerpts in this folder were invented for the demo. No private financial data was used.

The combined CSV contains 35 records in 10 explicitly supplied groups, with decimal USD amounts. The TypeScript fixture stores positive integer cents. Refunds are positive records with source=refund, and represent a credit to subtract exactly once. Orders are supporting context, not additional spend.

Each record has a readable original demo excerpt named <record id>.txt. The app can open these at /demo/<record id>.txt. Uploaded data is not represented by these files.

Expected review cases:
G01: Submitted amount $114.00 exceeds receipt and card total $112.00 by $2.00.
G02: Two shipments and card charges total $300.00; a later $40.00 posted refund brings net spend to $260.00, matching the submitted expense. Do not treat different line amounts as an error, subtract the refund twice, or add the order as spend.
G03: Submitted amount $286.50 exceeds receipt and card total $268.50 by $18.00. A possible transcription error is a hypothesis, not an established cause or the same cause as G01.
G04: Expense and card agree at $78.50, but receipt evidence is absent. Unresolved evidence is not proof of fraud or a wrong amount.
G05: Two $16.00 expense submissions and two $16.00 card records have equal totals, but no receipts. These might be two valid purchases; available evidence does not establish unique assignments or duplicate fraud.
G06–G10: Five clean controls with matching submitted, receipt and card amounts; G06 has an additional order that must not be double-counted.

The CSV has a groupId column because grouping is supplied for the demo. The fixture does not establish automatic entity resolution across unrelated real-world files.

WORLD CONTEXT DEMO (W01–W10, April 2025)
Loaded with "April 2025 statement" in the dataset strip above the review queue. People and amounts are fictional; W01–W04 billers are fictional; W05–W07 are real restaurants with fictional purchases.
W01–W04: four employees paid four different billers online with the company Visa through InvoiceCloud on April 11–12, 2025, and each payment posted twice. The dates fall inside a real, publicly reported event: Visa duplicate settlements on InvoiceCloud payments from Friday April 11 to Sunday April 13, 2025. Trace is not told this; it finds the notice on the public web through Bright Data.
W05–W07: three employees at three real San Francisco restaurants that take payments through Toast (Bodega SF, Taishoken San Francisco, Ramenwell; each has a public order.toasttab.com page). The purchases are fictional: each employee entered the receipt photographed before the tip, and the card settled 18–20% higher. Adding a tip after authorization is normal; nothing here suggests the restaurants did anything wrong. Public sources explain that the tip is added after the card authorization.
W08: a single overclaim ($286.50 vs $268.50) with no shared outside factor. It stays with a reviewer.
W09–W10: clean controls.
world-context-recorded.json holds a recorded live Bright Data run for the demo, created with scripts/record-world-context.ts.
