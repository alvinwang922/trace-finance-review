# Base44 connection

The browser app supports local evidence review without a connection. Its optional Base44 features are authenticated AI explanation drafts and cloud decision saves. It does not contain a simulated AI fallback.

The app is deployed at https://trace-expense-review-f366fc9e.base44.app with workspace-only access. The existing local project is linked and its public app identifiers are configured in the ignored `.env.local` file.

## Configure

1. Use the Base44 CLI to authenticate and create or link the team's app. The CLI creates `base44/.app.jsonc`; do not commit this local link file.
2. Copy `.env.example` to `.env.local`. Set `VITE_BASE44_APP_ID` to that app's ID and `VITE_BASE44_APP_BASE_URL` to its published HTTPS origin. These are public identifiers, not secrets. Restart the development server or rebuild after changing them.
3. Deploy `base44/entities/CaseDecision.json` with `base44 entities push` (or deploy the whole app with `base44 deploy --build --yes`). The config's build command creates the Vite `dist` directory. The current app and entity have already been deployed; these steps also apply when setting up another instance.
4. In the app, explicitly choose sign-in before using cloud actions. A failed/expired session displays an error rather than redirecting automatically.

## World context function (Bright Data)

`functions/worldResearch` searches and reads public web pages through Bright Data's hosted MCP server for the World context page. It needs one secret and no Bright Data zone setup:

```bash
base44 secrets set BRIGHTDATA_API_KEY <your Bright Data API key>
base44 functions deploy worldResearch
```

Check the exact `secrets set` syntax with `base44 secrets --help`. The function rejects signed-out callers so visitors cannot spend the team's credits. It accepts only `{ action: 'search', queries }` (up to 6 queries) or `{ action: 'scrape', urls }` (up to 3 HTTPS URLs), and returns search hits or page text. It never receives employee names or card data.

## Data and permissions

- Local imports, case calculations and local decisions do not invoke Base44. The client is created lazily, with automatic analytics disabled.
- Clicking the AI draft action sends only the selected case's linked record fields and case calculations to Base44's `Core.InvokeLLM`. It does not upload original files, use internet context, or contact the employee. Descriptions may contain private information; the UI must disclose the send before the user clicks.
- AI text is a reviewer draft. Its response schema requires an explanation and optional question. The client verifies that explanation citations refer to the selected record IDs. Citation checks do not prove every model statement is correct: the reviewer still checks the evidence.
- Clicking cloud save creates a new `CaseDecision` with dataset ID, case ID, status, and note. It does not save source records. Each save appends a row; the SDK returns only after the write succeeds.
- `loadDecisions(datasetId)` explicitly loads up to 500 newest decision events for that dataset, limited by the entity's owner-only read rule. The client validates the response fields and sorts newest first. When restoring one current decision per case, use the first event for that case. The caller should avoid overwriting newer local decisions and discard a response if the active dataset changes while loading.
- The entity's server-enforced row rules allow signed-in `admin` and `user` roles to create records. The create rule uses `$or` over two exact `user_condition.role` comparisons: Base44's CLI does not allow operators such as `$in` inside `user_condition`. Each user can read their own records using the server-managed `created_by_id`. Updates and deletes are denied. Additional custom app roles need another exact role condition in the create rule.
- No service-role credentials are used in the browser. Do not add tokens to `VITE_` environment variables.

## Verify after connecting

Hosted sign-in, a real AI response with correct currency amounts and record citations, and saving/loading a fictional review were verified on October 10, 2026. Workspace-only visibility was set and the signed-out hosted page requires sign-in. Cross-account row-permission tests have not been performed; verify ordinary-user isolation before using client data or expanding access. The demo data and test review are fictional.

## Official references

- [Project structure and config fields](https://docs.base44.com/developers/backend/overview/project-structure)
- [Entity schema fields](https://docs.base44.com/developers/backend/resources/entities/entity-schemas)
- [Row-level security conditions](https://docs.base44.com/developers/backend/resources/entities/security)
- [SDK Core integrations](https://docs.base44.com/developers/references/sdk/docs/type-aliases/integrations)

The implementation was also checked against the installed `@base44/sdk` TypeScript definitions for `createClient`, `auth.me`, `auth.hasToken`, `auth.redirectToLogin`, `integrations.Core.InvokeLLM`, and entity creation.
